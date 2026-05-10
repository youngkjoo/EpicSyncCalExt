// EpicSyncCal Content Script

// A generic heuristic for MyChart environments:
// 1. URL check: catches standard and some white-labeled portals (like Kaiser /mychartcn/).
// 2. Meta tag check: catches heavily white-labeled portals that strip "mychart" from the URL 
//    but still include the iOS Smart App Banner to prompt downloading the MyChart app.
const href = window.location.href.toLowerCase();
if (href.includes('mychart') || document.querySelector('meta[name="apple-itunes-app"][content*="mychart"]')) {
    console.log("EpicSyncCal: Activity detected on a MyChart domain.");
    injectNetworkInterceptor();
}

function injectNetworkInterceptor() {
    // To bypass the strict Content Security Policy (which blocks 'unsafe-inline'),
    // we must load the interceptor logic from an external file packaged in our extension.

    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    script.onload = function () {
        this.remove(); // Clean up DOM after execution
    };
    (document.head || document.documentElement).appendChild(script);
}

// Listen for the payload coming from the injected script
window.addEventListener('message', (event) => {
    // Only accept messages from the same frame
    if (event.source !== window || !event.data || event.data.type !== 'EPIC_SYNC_CAL_PAYLOAD') {
        return;
    }

    const rawData = event.data.payload;
    console.log("EpicSyncCal (Isolated World): Received payload from injected script.", rawData);

    // Retrieve the active patient name we scraped earlier from the DOM
    chrome.storage.local.get(['activePatients', 'confirmedSession'], (result) => {
        let activePatient = "Unknown";
        if (result.activePatients && result.activePatients[window.location.hostname]) {
            activePatient = result.activePatients[window.location.hostname];
        }

        const hostname = window.location.hostname;

        const forwardPayload = () => {
            const toast = showToast("EpicSyncCal: Syncing appointments to Google Calendar...", 0); // Persistent

            chrome.runtime.sendMessage({
                type: 'PROCESS_EPIC_PAYLOAD',
                payload: rawData,
                hostname: hostname,
                patientName: activePatient
            }, (response) => {
                if (chrome.runtime.lastError || !response || response.ignored) {
                    // Silently ignore non-appointment payloads and remove the persistent toast
                    removeToast(toast);
                    return;
                }

                if (response.error) {
                    toast.textContent = `EpicSyncCal Error: ${response.error}`;
                    toast.style.backgroundColor = "#d93025";
                    setTimeout(() => removeToast(toast), 6000);
                } else if (response.success) {
                    const { created, updated, canceled } = response.details;
                    toast.innerHTML = `<strong>EpicSyncCal:</strong> Sync complete! <br><small>Added: ${created} | Updated: ${updated} | Canceled: ${canceled}</small>`;
                    toast.style.backgroundColor = "#188038"; // Success green
                    setTimeout(() => removeToast(toast), 5000);
                } else {
                    toast.textContent = "EpicSyncCal: No new appointments found to sync.";
                    setTimeout(() => removeToast(toast), 4000);
                }
            });
        };

        // Check if session is explicitly confirmed for this specific patient
        if (result.confirmedSession &&
            result.confirmedSession.hostname === hostname &&
            result.confirmedSession.patientName === activePatient) {
            forwardPayload();
        } else {
            // Fetch the profile details from the background worker so we can show them to the user
            chrome.runtime.sendMessage({
                type: 'VALIDATE_PROFILE',
                hostname: hostname,
                patientName: activePatient
            }, (profileDetails) => {
                if (chrome.runtime.lastError) {
                    console.error("EpicSyncCal: Background worker error getting profile", chrome.runtime.lastError);
                    injectConfirmationBanner(activePatient, hostname, "Unknown", "Unknown Calendar", forwardPayload);
                } else {
                    injectConfirmationBanner(activePatient, hostname, profileDetails.prefix, profileDetails.calendarName, forwardPayload);
                }
            });
        }
    });
});

function injectConfirmationBanner(patientName, hostname, prefix, calendarName, onConfirm) {
    if (document.getElementById('epicsynccal-confirm-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'epicsynccal-confirm-banner';
    banner.style.position = 'fixed';
    banner.style.top = '0';
    banner.style.left = '0';
    banner.style.width = '100%';
    banner.style.backgroundColor = '#fff3cd';
    banner.style.color = '#856404';
    banner.style.padding = '15px 20px';
    banner.style.zIndex = '9999999';
    banner.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
    banner.style.fontFamily = 'system-ui, sans-serif';
    banner.style.display = 'flex';
    banner.style.justifyContent = 'space-between';
    banner.style.alignItems = 'center';
    banner.style.borderBottom = '2px solid #ffeeba';
    banner.style.boxSizing = 'border-box';

    const text = document.createElement('span');
    text.innerHTML = `<strong>EpicSyncCal v0.2:</strong> Ready to sync <strong>${patientName}</strong>'s appointments to <strong>${calendarName}</strong> using prefix <strong>${prefix}</strong>. Is this correct?`;

    const btnContainer = document.createElement('div');

    const confirmBtn = document.createElement('button');
    confirmBtn.innerText = 'Sync Now';
    confirmBtn.style.backgroundColor = '#28a745';
    confirmBtn.style.color = 'white';
    confirmBtn.style.border = 'none';
    confirmBtn.style.padding = '8px 16px';
    confirmBtn.style.borderRadius = '4px';
    confirmBtn.style.cursor = 'pointer';
    confirmBtn.style.fontWeight = 'bold';
    confirmBtn.style.marginLeft = '15px';

    const cancelBtn = document.createElement('button');
    cancelBtn.innerText = 'Cancel';
    cancelBtn.style.backgroundColor = '#6c757d';
    cancelBtn.style.color = 'white';
    cancelBtn.style.border = 'none';
    cancelBtn.style.padding = '8px 16px';
    cancelBtn.style.borderRadius = '4px';
    cancelBtn.style.cursor = 'pointer';
    cancelBtn.style.marginLeft = '10px';

    confirmBtn.onclick = () => {
        chrome.storage.local.set({
            confirmedSession: {
                hostname: hostname,
                patientName: patientName,
                timestamp: Date.now()
            }
        }, () => {
            banner.remove();
            onConfirm();
        });
    };

    cancelBtn.onclick = () => {
        banner.remove();
        console.log("EpicSyncCal: Sync canceled by user.");
    };

    btnContainer.appendChild(confirmBtn);
    btnContainer.appendChild(cancelBtn);

    banner.appendChild(text);
    banner.appendChild(btnContainer);

    document.body.appendChild(banner);
}

// --- Patient Name Harvesting ---
// Because some hospitals (like HHC) do not include the patient name in the UpcomingVisits payload,
// we scrape it from the DOM when the user is navigating the portal (e.g., the Home dashboard).
function harvestPatientName() {
    // Look for common Epic "Welcome, Name" or "Name's health record" headers
    const findName = () => {
        // Strategy 1: The standard welcome header
        const welcomeHeaders = Array.from(document.querySelectorAll('h1, h2, span, div'))
            .filter(el => el.textContent && el.textContent.includes('Welcome,'));

        for (const el of welcomeHeaders) {
            const text = el.textContent.trim();
            const match = text.match(/Welcome,\s*([A-Za-z]+)/i);
            if (match && match[1]) {
                return match[1];
            }
        }

        // Strategy 2: Look for proxy switchers or profile buttons
        const profileElements = document.querySelectorAll('.name-text, .user-name, [data-id="user-name"]');
        for (const el of profileElements) {
            if (el.textContent.trim()) {
                // Try to grab just the first name
                return el.textContent.trim().split(' ')[0];
            }
        }

        return null; // Keep trying if the SPA hasn't rendered it yet
    };

    const name = findName();
    if (name) {
        // Save the active patient for this domain
        chrome.storage.local.get(['activePatients', 'confirmedSession'], (result) => {
            let activePatients = result.activePatients || {};
            if (activePatients[window.location.hostname] !== name) {
                activePatients[window.location.hostname] = name;

                let storageUpdates = { activePatients: activePatients };

                // Invalidate confirmed session if patient name changed for this hostname
                if (result.confirmedSession &&
                    result.confirmedSession.hostname === window.location.hostname &&
                    result.confirmedSession.patientName !== name) {
                    console.log("EpicSyncCal: Patient name changed. Invalidating previous session confirmation.");
                    storageUpdates.confirmedSession = null;
                }

                chrome.storage.local.set(storageUpdates, () => {
                    console.log(`EpicSyncCal: Harvested active patient name: ${name}`);
                });
            }
        });
    } else {
        // If we didn't find it immediately, the SPA might still be rendering. 
        // We'll try again shortly.
        setTimeout(harvestPatientName, 2000);
    }
}

// Start harvesting when the content script loads
harvestPatientName();

function showToast(message, duration = 4000) {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.position = 'fixed';
    toast.style.bottom = '20px';
    toast.style.right = '20px';
    toast.style.backgroundColor = '#1a73e8';
    toast.style.color = 'white';
    toast.style.padding = '12px 24px';
    toast.style.borderRadius = '8px';
    toast.style.zIndex = '999999';
    toast.style.fontFamily = 'system-ui, sans-serif';
    toast.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
    toast.style.transition = 'opacity 0.3s';

    document.body.appendChild(toast);

    if (duration > 0) {
        setTimeout(() => removeToast(toast), duration);
    }
    return toast;
}

function removeToast(toast) {
    if (!toast || !toast.parentNode) return;
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
}
