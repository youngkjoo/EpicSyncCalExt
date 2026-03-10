// EpicSyncCal Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
    console.log("EpicSyncCal Extension Installed.");
});

// Listen for messages from content scripts or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'VALIDATE_PROFILE') {
        // Content script is asking for the active profile details to display in the UI banner
        const hostname = message.hostname;
        const patientName = message.patientName || "Unknown";

        getProfileDetails(hostname, patientName).then(details => {
            sendResponse(details);
        }).catch(e => {
            console.error(e);
            sendResponse({ error: e.message });
        });
        return true; // async response
    }

    if (message.type === 'PROCESS_EPIC_PAYLOAD') {
        const rawPayload = message.payload;
        const hostname = message.hostname;
        const patientName = message.patientName || "Unknown";
        console.log(`Received payload from MyChart content script (${hostname} - ${patientName}):`, rawPayload);

        // Let the content script know we got it immediately
        sendResponse({ status: "Processing" });

        // Kick off the async sync process
        processSync(hostname, patientName, rawPayload).catch(e => console.error("EpicSyncCal Sync Error:", e));
        return true;
    }
    return true; // Keep message channel open for async response if needed elsewhere
});

async function getProfileDetails(hostname, patientName) {
    const settings = await chrome.storage.local.get(['profiles', 'targetCalendarId']);
    let calendarId = null;
    let prefix = "[Epic]";

    const profileKey = `${hostname}-${patientName}`;

    if (settings.profiles && settings.profiles[profileKey]) {
        calendarId = settings.profiles[profileKey].calendarId;
        prefix = settings.profiles[profileKey].prefix || "[Epic]";
    } else if (settings.profiles && settings.profiles[hostname]) {
        calendarId = settings.profiles[hostname].calendarId;
        prefix = settings.profiles[hostname].prefix || "[Epic]";
    } else if (settings.targetCalendarId) {
        calendarId = settings.targetCalendarId;
    }

    if (!calendarId) {
        return { prefix: prefix, calendarName: "None (Please Configure)" };
    }

    const token = await getAuthToken().catch(() => null);
    if (!token) {
        return { prefix: prefix, calendarName: "Google Auth Required" };
    }

    try {
        const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) {
            const data = await response.json();
            return { prefix: prefix, calendarName: data.summary || "Unknown Calendar" };
        }
    } catch (e) { }

    return { prefix: prefix, calendarName: calendarId };
}

async function processSync(hostname, patientName, payload) {
    // 0. (v0.2 Sync Gate) Verify this session is explicitly confirmed before doing anything
    const settings = await chrome.storage.local.get(['profiles', 'targetCalendarId', 'confirmedSession']); // Target used as legacy fallback

    if (!settings.confirmedSession ||
        settings.confirmedSession.hostname !== hostname ||
        settings.confirmedSession.patientName !== patientName) {
        console.warn(`EpicSyncCal: Sync aborted. Session for ${patientName} on ${hostname} is unconfirmed.`);
        return;
    }

    // 1. Check if we have a valid calendar configured for this domain+patient
    let calendarId = null;
    let prefix = "[Epic]";

    const profileKey = `${hostname}-${patientName}`;

    if (settings.profiles && settings.profiles[profileKey]) {
        // Exact match for this specific patient on this domain
        calendarId = settings.profiles[profileKey].calendarId;
        prefix = settings.profiles[profileKey].prefix || "[Epic]";
    } else if (settings.profiles && settings.profiles[hostname]) {
        // Fallback to the domain-level mapping if no patient specific mapping exists
        calendarId = settings.profiles[hostname].calendarId;
        prefix = settings.profiles[hostname].prefix || "[Epic]";
    } else if (settings.targetCalendarId) {
        calendarId = settings.targetCalendarId; // Legacy single-calendar fallback
    }

    if (!calendarId) {
        console.warn(`EpicSyncCal: No target calendar mapped for domain ${hostname}. Plase click the extension to map it.`);
        return;
    }

    // 2. Fetch the OAuth Token
    const token = await getAuthToken();
    if (!token) {
        console.error("EpicSyncCal: Failed to get Google OAuth token. Please sign in via the extension popup.");
        return;
    }

    // 3. Normalize the weird MyChart JSON array into standard Appointment objects
    const upcomingMyChart = normalizeMyChartPayload(payload, prefix);

    if (upcomingMyChart.length === 0) {
        console.log("No upcoming appointments found in payload. Nothing to sync.");
        return;
    }

    console.log(`Normalized ${upcomingMyChart.length} upcoming appointments. Syncing to Google Calendar...`);

    // 4. Fetch existing Google Calendar events tagged by our extension
    const existingEventsMap = await getExistingEvents(token, calendarId, prefix);

    // 5. Diff & Sync
    await syncToCalendar(token, calendarId, upcomingMyChart, existingEventsMap, prefix);

    console.log("Sync complete!");
}

function normalizeMyChartPayload(payload, prefix) {
    // MyChart JSON structures can vary wildly by hospital.
    // This is a generic/heuristic approach for common Epic FHIR wrappers or internal models.
    let visits = [];

    // Look for common array keys
    if (Array.isArray(payload)) {
        visits = payload;
    } else if (payload.UpcomingVisits && Array.isArray(payload.UpcomingVisits)) {
        visits = payload.UpcomingVisits;
    } else if (payload.Visits && Array.isArray(payload.Visits)) {
        visits = payload.Visits;
    } else if (payload.LaterVisitsList && Array.isArray(payload.LaterVisitsList)) {
        // Specific format intercepted from user's MyChart
        visits = [...payload.LaterVisitsList];
        if (payload.NextNDaysVisits) visits = visits.concat(payload.NextNDaysVisits);
        if (payload.InProgressVisits) visits = visits.concat(payload.InProgressVisits);
    } else if (payload.entry && Array.isArray(payload.entry)) {
        // FHIR Bundle style
        visits = payload.entry.map(e => e.resource).filter(r => r && r.resourceType === 'Encounter' || r.resourceType === 'Appointment');
    }

    return visits.map(visit => {
        // Build a normalized object. We must be highly defensive here.
        const id = visit.VisitID || visit.id || visit.AppointmentID || visit.EncounterID || visit.Id || visit.Csn;
        const start = visit.PrimaryDate || visit.Date || visit.StartTime || visit.start || visit.AppointmentTime;
        const end = visit.EndDate || visit.EndTime || visit.end || null;

        // MyChart specific fields can be nested deeply
        let providerName = visit.PrimaryProviderName || visit.ProviderName || visit.Provider?.Name || visit.participant?.[0]?.actor?.display;
        if (!providerName && visit.Providers && visit.Providers.length > 0) providerName = visit.Providers[0].Name;
        providerName = providerName || "Provider TBD";

        let locationName = "Location TBD";
        let departmentName = visit.PrimaryDepartment?.Name || visit.DepartmentName || visit.LocationName || visit.Location?.Name;
        if (!departmentName && visit.Department) departmentName = visit.Department.Name;

        // Extract full address if available and make it the primary Calendar Location for easy GPS navigation
        if (visit.PrimaryDepartment && visit.PrimaryDepartment.Address && Array.isArray(visit.PrimaryDepartment.Address)) {
            const addressString = visit.PrimaryDepartment.Address.filter(line => line.trim() !== "").join(", ");
            if (addressString) {
                locationName = addressString;
            }
        } else if (departmentName) {
            // Fallback to department name only if no address exists at all
            locationName = departmentName;
        }

        const visitType = visit.VisitTypeName || visit.AppointmentType || visit.Title || "Medical Appointment";

        // Extract Department, Specialty, and Phone Number for the description
        let descriptionLines = [];
        if (visit.ArrivalTime) {
            descriptionLines.push(`Arrive by: ${visit.ArrivalTime}`);
        }
        if (departmentName && locationName !== departmentName) {
            // Only add department name to description if it's not already the sole Location
            descriptionLines.push(`Department: ${departmentName}`);
        }
        if (visit.PrimaryDepartment) {
            if (visit.PrimaryDepartment.Specialty && visit.PrimaryDepartment.Specialty.Title) {
                descriptionLines.push(`Specialty: ${visit.PrimaryDepartment.Specialty.Title}`);
            }
            if (visit.PrimaryDepartment.PhoneNumber) {
                descriptionLines.push(`Phone: ${visit.PrimaryDepartment.PhoneNumber}`);
            }
        }

        if (!id || !start) return null;

        // --- Timezone Handling ---
        // MyChart sends time as '3/27/2026 12:45:00 PM' and a separate TimeZone like 'EDT'.
        // Google Calendar requires a clear timezone offset or a standard IANA timezone.
        const tzAbbr = visit.TimeZone || visit.ClientTimeZoneMarker || "EST";

        // Map common US abbreviations to IANA to build an offset-aware string.
        // Google Calendar handles explicit IANA timezones best when passing 'dateTime'.
        const tzMap = {
            'EST': 'America/New_York',
            'EDT': 'America/New_York',
            'CST': 'America/Chicago',
            'CDT': 'America/Chicago',
            'MST': 'America/Denver',
            'MDT': 'America/Denver',
            'PST': 'America/Los_Angeles',
            'PDT': 'America/Los_Angeles',
            'AKST': 'America/Anchorage',
            'AKDT': 'America/Anchorage',
            'HST': 'Pacific/Honolulu'
        };

        const ianaTz = tzMap[tzAbbr.toUpperCase()] || 'America/New_York'; // Fallback to Eastern

        // Format the raw PrimaryDate ('3/27/2026 12:45:00 PM') into a sortable standard format
        // Because passing simple dates to new Date() assumes LOCAL browser time, we must structure it 
        // Convert '3/27/2026 12:45:00 PM' -> '2026-03-27T12:45:00' (Naive local time)
        const naiveDateObj = new Date(start);
        const year = naiveDateObj.getFullYear();
        const month = String(naiveDateObj.getMonth() + 1).padStart(2, '0');
        const day = String(naiveDateObj.getDate()).padStart(2, '0');
        const hours = String(naiveDateObj.getHours()).padStart(2, '0');
        const mins = String(naiveDateObj.getMinutes()).padStart(2, '0');
        const secs = String(naiveDateObj.getSeconds()).padStart(2, '0');

        const naiveStartStr = `${year}-${month}-${day}T${hours}:${mins}:${secs}`;

        let naiveEndStr;
        if (end) {
            const naiveEndObj = new Date(end);
            const eYear = naiveEndObj.getFullYear();
            const eMonth = String(naiveEndObj.getMonth() + 1).padStart(2, '0');
            const eDay = String(naiveEndObj.getDate()).padStart(2, '0');
            const eHours = String(naiveEndObj.getHours()).padStart(2, '0');
            const eMins = String(naiveEndObj.getMinutes()).padStart(2, '0');
            const eSecs = String(naiveEndObj.getSeconds()).padStart(2, '0');
            naiveEndStr = `${eYear}-${eMonth}-${eDay}T${eHours}:${eMins}:${eSecs}`;
        } else if (visit.DurationInMinutes) {
            const naiveEndObj = new Date(naiveDateObj.getTime() + (visit.DurationInMinutes * 60 * 1000));
            naiveEndStr = `${naiveEndObj.getFullYear()}-${String(naiveEndObj.getMonth() + 1).padStart(2, '0')}-${String(naiveEndObj.getDate()).padStart(2, '0')}T${String(naiveEndObj.getHours()).padStart(2, '0')}:${String(naiveEndObj.getMinutes()).padStart(2, '0')}:${String(naiveEndObj.getSeconds()).padStart(2, '0')}`;
        } else {
            const naiveEndObj = new Date(naiveDateObj.getTime() + 60 * 60 * 1000);
            naiveEndStr = `${naiveEndObj.getFullYear()}-${String(naiveEndObj.getMonth() + 1).padStart(2, '0')}-${String(naiveEndObj.getDate()).padStart(2, '0')}T${String(naiveEndObj.getHours()).padStart(2, '0')}:${String(naiveEndObj.getMinutes()).padStart(2, '0')}:${String(naiveEndObj.getSeconds()).padStart(2, '0')}`;
        }

        return {
            id: String(id),
            title: `${prefix} ${visitType}: ${providerName}`,
            start: { dateTime: naiveStartStr, timeZone: ianaTz },
            end: { dateTime: naiveEndStr, timeZone: ianaTz },
            location: locationName,
            description: descriptionLines.join('\n')
        };
    }).filter(v => v !== null);
}

function getAuthToken() {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: false }, (token) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(token);
            }
        });
    });
}

async function getExistingEvents(token, calendarId, prefix) {
    const apiBase = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

    // Only fetch events from today forward to avoid massive scans and touching past history
    const timeMin = new Date().toISOString();
    let url = `${apiBase}?timeMin=${encodeURIComponent(timeMin)}&singleEvents=true&maxResults=500`;

    const eventsMap = new Map();
    let nextPageToken = null;

    do {
        const fetchUrl = nextPageToken ? `${url}&pageToken=${nextPageToken}` : url;
        const response = await fetch(fetchUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) break;

        const data = await response.json();
        const events = data.items || [];

        for (const event of events) {
            // Find our specific appointments by checking for our custom property
            if (event.extendedProperties && event.extendedProperties.private && event.extendedProperties.private.myChartId) {
                // Ensure we only diff against events matching this specific prefix/profile if they share a calendar
                if (event.summary && event.summary.startsWith(prefix)) {
                    eventsMap.set(event.extendedProperties.private.myChartId, event);
                }
            }
        }

        nextPageToken = data.nextPageToken;
    } while (nextPageToken);

    return eventsMap;
}

async function syncToCalendar(token, calendarId, upcomingMyChart, existingEventsMap, prefix) {
    const apiBase = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

    // 1. Create or Update active appointments
    for (const appt of upcomingMyChart) {
        const existingEvent = existingEventsMap.get(appt.id);

        const eventBody = {
            summary: appt.title,
            location: appt.location,
            description: appt.description,
            start: appt.start, // Now an object: { dateTime: "...", timeZone: "..." }
            end: appt.end,     // Now an object: { dateTime: "...", timeZone: "..." }
            extendedProperties: {
                private: { myChartId: appt.id }
            }
        };

        if (existingEvent) {
            // Check if details changed (simplified: check start time, we compare the naive date strings)
            // Existing Google Calendar events might return as pure ISO depending on settings, so we need a robust check.
            const googleStartStr = existingEvent.start.dateTime ? existingEvent.start.dateTime.split(/[+-Z]/)[0] : '';
            const myChartStartStr = appt.start.dateTime;

            if (googleStartStr !== myChartStartStr || existingEvent.location !== appt.location || existingEvent.summary.includes("[CANCELED]")) {
                console.log(`Updating event: ${appt.id}`);
                await fetch(`${apiBase}/${existingEvent.id}`, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(eventBody)
                });
            }
            // Remove from map to track what's no longer in MyChart
            existingEventsMap.delete(appt.id);
        } else {
            // Create new
            console.log(`Creating new event: ${appt.id}`);
            await fetch(apiBase, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(eventBody)
            });
        }
    }

    // 2. Cancel orphan events (Events in GCal but no longer in MyChart future payload)
    for (const [orphanId, orphanEvent] of existingEventsMap.entries()) {
        if (!orphanEvent.summary.includes("[CANCELED]")) {
            console.log(`Canceling orphan event: ${orphanId}`);

            const canceledBody = {
                summary: `[CANCELED] ${orphanEvent.summary}`,
                start: orphanEvent.start,
                end: orphanEvent.end,
                transparency: "transparent", // Mark as Free time
                extendedProperties: orphanEvent.extendedProperties
            };

            await fetch(`${apiBase}/${orphanEvent.id}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(canceledBody)
            });
        }
    }

    console.log("Sync complete!");
}
