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

        // Kick off the sync process and wait for result
        processSync(hostname, patientName, rawPayload)
            .then(result => {
                sendResponse(result);
            })
            .catch(e => {
                console.error("EpicSyncCal Sync Error:", e);
                sendResponse({ error: e.message });
            });
        return true; // Keep channel open for async response
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
        return { ignored: true };
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
        return { error: "No calendar mapped for this provider. Click the extension icon to set it up." };
    }

    // 2. Fetch the OAuth Token
    const token = await getAuthToken();
    if (!token) {
        console.error("EpicSyncCal: Failed to get Google OAuth token. Please sign in via the extension popup.");
        return { error: "Google sign-in required. Click the extension icon." };
    }

    // 3. Normalize the weird MyChart JSON array into standard Appointment objects
    const { visits: upcomingMyChart, isRecognized } = normalizeMyChartPayload(payload, prefix);

    if (upcomingMyChart.length === 0) {
        if (isRecognized) {
            console.log("Recognized visits payload but it was empty.");
            return { success: true, count: 0, details: { created: 0, updated: 0, canceled: 0 } };
        }
        return { ignored: true };
    }

    console.log(`Normalized ${upcomingMyChart.length} upcoming appointments. Syncing to Google Calendar...`);

    // 4. Fetch existing Google Calendar events tagged by our extension
    const existingEventsMap = await getExistingEvents(token, calendarId, prefix);

    // 5. Diff & Sync
    const syncResult = await syncToCalendar(token, calendarId, upcomingMyChart, existingEventsMap, prefix);

    console.log("Sync complete!", syncResult);
    return { success: true, count: upcomingMyChart.length, details: syncResult };
}

function normalizeMyChartPayload(payload, prefix) {
    // MyChart JSON structures can vary wildly by hospital.
    // This is a generic/heuristic approach for common Epic FHIR wrappers or internal models.
    let visits = [];
    let isRecognized = false;

    // Look for common array keys
    if (Array.isArray(payload)) {
        visits = payload;
        isRecognized = true;
    } else if (payload.UpcomingVisits && Array.isArray(payload.UpcomingVisits)) {
        visits = payload.UpcomingVisits;
        isRecognized = true;
    } else if (payload.Visits && Array.isArray(payload.Visits)) {
        visits = payload.Visits;
        isRecognized = true;
    } else if (payload.LaterVisitsList && Array.isArray(payload.LaterVisitsList)) {
        // Specific format intercepted from Kaiser/Epic MyChart
        visits = [...payload.LaterVisitsList];
        if (payload.NextNDaysVisits && Array.isArray(payload.NextNDaysVisits)) visits = visits.concat(payload.NextNDaysVisits);
        if (payload.InProgressVisits && Array.isArray(payload.InProgressVisits)) visits = visits.concat(payload.InProgressVisits);
        isRecognized = true;
    } else if (payload.List && Array.isArray(payload.List)) {
        // Another common list format
        visits = payload.List;
        isRecognized = true;
    } else if (payload.List && typeof payload.List === 'object') {
        // Sometimes it's an object containing the list
        const possibleList = Object.values(payload.List).find(val => Array.isArray(val));
        if (possibleList) {
            visits = possibleList;
            isRecognized = true;
        }
    } else if (payload.entry && Array.isArray(payload.entry)) {
        // FHIR Bundle style
        visits = payload.entry.map(e => e.resource).filter(r => r && (r.resourceType === 'Encounter' || r.resourceType === 'Appointment'));
        isRecognized = true;
    }

    const normalized = visits.map(visit => {
        // Build a normalized object. We must be highly defensive here.
        const id = visit.VisitID || visit.id || visit.AppointmentID || visit.EncounterID || visit.Id || visit.Csn;
        const start = visit.PrimaryDate || visit.Date || visit.StartTime || visit.start || visit.AppointmentTime;
        const end = visit.EndDate || visit.EndTime || visit.end || null;

        if (!id || !start) return null;

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

        // --- Timezone Handling ---
        const tzAbbr = visit.TimeZone || visit.ClientTimeZoneMarker || "EST";
        const tzMap = {
            'EST': 'America/New_York', 'EDT': 'America/New_York',
            'CST': 'America/Chicago', 'CDT': 'America/Chicago',
            'MST': 'America/Denver', 'MDT': 'America/Denver',
            'PST': 'America/Los_Angeles', 'PDT': 'America/Los_Angeles',
            'AKST': 'America/Anchorage', 'AKDT': 'America/Anchorage',
            'HST': 'Pacific/Honolulu'
        };
        const ianaTz = tzMap[tzAbbr.toUpperCase()] || 'America/New_York';

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
            naiveEndStr = `${naiveEndObj.getFullYear()}-${String(naiveEndObj.getMonth() + 1).padStart(2, '0')}-${String(naiveEndObj.getDate()).padStart(2, '0')}T${String(naiveEndObj.getHours()).padStart(2, '0')}:${String(naiveEndObj.getMinutes()).padStart(2, '0')}:${String(naiveEndObj.getSeconds()).padStart(2, '0')}`;
        } else {
            const duration = visit.DurationInMinutes || 60;
            const naiveEndObj = new Date(naiveDateObj.getTime() + (duration * 60 * 1000));
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

    return { visits: normalized, isRecognized };
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
            if (event.extendedProperties?.private?.myChartId) {
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
    let created = 0;
    let updated = 0;
    let canceled = 0;

    for (const appt of upcomingMyChart) {
        const existingEvent = existingEventsMap.get(appt.id);
        const eventBody = {
            summary: appt.title,
            location: appt.location,
            description: appt.description,
            start: appt.start,
            end: appt.end,
            extendedProperties: { private: { myChartId: appt.id } }
        };

        if (existingEvent) {
            const googleStartStr = existingEvent.start.dateTime ? existingEvent.start.dateTime.split(/[+-Z]/)[0] : '';
            const myChartStartStr = appt.start.dateTime;
            if (googleStartStr !== myChartStartStr || existingEvent.location !== appt.location || existingEvent.summary.includes("[CANCELED]")) {
                const response = await fetch(`${apiBase}/${existingEvent.id}`, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(eventBody)
                });
                if (response.ok) updated++;
            }
            existingEventsMap.delete(appt.id);
        } else {
            const response = await fetch(apiBase, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(eventBody)
            });
            if (response.ok) created++;
        }
    }

    for (const [orphanId, orphanEvent] of existingEventsMap.entries()) {
        if (!orphanEvent.summary.includes("[CANCELED]")) {
            const canceledBody = {
                summary: `[CANCELED] ${orphanEvent.summary}`,
                start: orphanEvent.start,
                end: orphanEvent.end,
                transparency: "transparent",
                extendedProperties: orphanEvent.extendedProperties
            };
            const response = await fetch(`${apiBase}/${orphanEvent.id}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(canceledBody)
            });
            if (response.ok) canceled++;
        }
    }
    return { created, updated, canceled };
}
