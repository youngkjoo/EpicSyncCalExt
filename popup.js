document.addEventListener('DOMContentLoaded', () => {
    const authBtn = document.getElementById('auth-btn');
    const authStatus = document.getElementById('auth-status');
    const settingsSection = document.getElementById('settings-section');
    const calendarSelect = document.getElementById('calendar-select');

    // Check auth status on load
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
        if (chrome.runtime.lastError || !token) {
            authStatus.textContent = "Not authenticated.";
        } else {
            showSettings(token);
        }
    });

    authBtn.addEventListener('click', () => {
        authStatus.textContent = "Authenticating...";
        chrome.identity.getAuthToken({ interactive: true }, (token) => {
            if (chrome.runtime.lastError) {
                authStatus.textContent = "Error: " + chrome.runtime.lastError.message;
            } else {
                showSettings(token);
            }
        });
    });

    function showSettings(token) {
        authBtn.style.display = 'none';
        authStatus.textContent = "Authenticated!";
        settingsSection.style.display = 'block';

        // Fetch calendars using token and populate calendarSelect
        fetchCalendars(token);
    }

    async function fetchCalendars(token) {
        try {
            const response = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error: ${response.status}`);
            }

            const data = await response.json();

            // Clear existing options
            calendarSelect.innerHTML = '';

            if (data.items && data.items.length > 0) {
                // Add default "select one" option
                const defaultOption = document.createElement('option');
                defaultOption.value = "";
                defaultOption.textContent = "-- Select a Calendar --";
                calendarSelect.appendChild(defaultOption);

                // Add all calendars the user has write access to
                data.items.forEach(calendar => {
                    if (calendar.accessRole === 'owner' || calendar.accessRole === 'writer') {
                        const option = document.createElement('option');
                        option.value = calendar.id;
                        option.textContent = calendar.summaryOverride || calendar.summary;
                        calendarSelect.appendChild(option);
                    }
                });

                // Default to first option
                calendarSelect.selectedIndex = 0;

                // Detect current active tab domain and load its specific profile
                chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
                    if (tabs && tabs[0]) {
                        try {
                            const url = new URL(tabs[0].url);
                            let hostname = url.hostname;

                            // Check if it's an internal browser page or empty
                            if (!hostname || url.protocol === 'chrome:' || url.protocol === 'edge:' || url.protocol === 'about:') {
                                hostname = 'Global Default';
                            }

                            document.getElementById('active-domain').textContent = hostname;

                            // Load existing profile for this hostname + active patient combo
                            chrome.storage.local.get(['profiles', 'activePatients'], (result) => {
                                const activePatientName = (result.activePatients && result.activePatients[hostname]) ? result.activePatients[hostname] : "Unknown";

                                // Update UI to reflect both Domain and Patient
                                document.getElementById('active-domain').textContent = `${hostname} (Patient: ${activePatientName})`;

                                // Our unique key is now Domain-PatientName
                                const profileKey = `${hostname}-${activePatientName}`;
                                // Store it on the DOM element for the Save button to use easiest
                                document.getElementById('active-domain').dataset.profileKey = profileKey;

                                const profiles = result.profiles || {};
                                if (profiles[profileKey]) {
                                    if (profiles[profileKey].calendarId) {
                                        calendarSelect.value = profiles[profileKey].calendarId;
                                    }
                                    if (profiles[profileKey].prefix) {
                                        document.getElementById('event-prefix').value = profiles[profileKey].prefix;
                                    }
                                } else if (profiles[hostname]) {
                                    // Fallback to legacy hostname-only profile during migration
                                    if (profiles[hostname].calendarId) {
                                        calendarSelect.value = profiles[hostname].calendarId;
                                    }
                                    if (profiles[hostname].prefix) {
                                        document.getElementById('event-prefix').value = profiles[hostname].prefix;
                                    }
                                } else {
                                    // Fallback to legacy single setting if it exists 
                                    chrome.storage.local.get(['targetCalendarId'], (legacyResult) => {
                                        if (legacyResult.targetCalendarId) {
                                            calendarSelect.value = legacyResult.targetCalendarId;
                                        }
                                    });
                                }
                            });
                        } catch (e) {
                            document.getElementById('active-domain').textContent = 'Global Default (Patient: Unknown)';
                            document.getElementById('active-domain').dataset.profileKey = 'Global Default-Unknown';
                        }
                    } else {
                        document.getElementById('active-domain').textContent = 'Global Default (Patient: Unknown)';
                        document.getElementById('active-domain').dataset.profileKey = 'Global Default-Unknown';
                    }
                });
            } else {
                calendarSelect.innerHTML = '<option value="">No calendars found</option>';
            }
        } catch (error) {
            console.error('Error fetching calendars:', error);
            const settingsStatus = document.getElementById('settings-status');
            settingsStatus.textContent = "Failed to load calendars: " + error.message;
            settingsStatus.style.color = "red";
        }
    }

    // Handle saving the selected calendar and prefix for the active domain+patient
    const saveBtn = document.getElementById('save-settings-btn');
    saveBtn.addEventListener('click', () => {
        const selectedId = calendarSelect.value;
        const prefixVal = document.getElementById('event-prefix').value.trim() || '[Epic]';
        const profileKey = document.getElementById('active-domain').dataset.profileKey || 'Global Default-Unknown';
        const settingsStatus = document.getElementById('settings-status');

        if (!selectedId) {
            settingsStatus.textContent = "Please select a calendar.";
            settingsStatus.style.color = "red";
            return;
        }

        chrome.storage.local.get(['profiles'], (result) => {
            let profiles = result.profiles || {};

            profiles[profileKey] = {
                calendarId: selectedId,
                prefix: prefixVal
            };

            chrome.storage.local.set({ profiles: profiles }, () => {
                settingsStatus.textContent = "Profile Saved successfully!";
                settingsStatus.style.color = "green";
                setTimeout(() => { settingsStatus.textContent = ""; }, 3000);
            });
        });
    });
});
