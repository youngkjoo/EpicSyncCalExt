# PRD: EpicSyncCal (Browser Extension Edition)

## 1. Executive Summary
**EpicSyncCal** is a private browser extension (Chrome/Firefox/Safari) designed solely for personal use. It synchronizes upcoming medical appointments from an Epic MyChart patient portal directly to a personal Google Calendar. By operating entirely within the user's browser during an active MyChart session, this solution mathematically bypasses the complex, multi-week process of registering a FHIR application and seeking specific IT/allowlist approval from hospital administrators.

## 2. Goals & Objectives
*   **Zero IT Approval Required:** Operate completely within the context of the user's authenticated web browser session, sidestepping the need for official Epic FHIR API app registration, SMART scopes, or hospital IT whitelisting.
*   **Multi-Account & Multi-System Support:** Support syncing from multiple distinct MyChart accounts (e.g., different hospital systems).
*   **Proxy Access & Multi-Login Differentiation:** Distinguish between multiple patient accounts logged into the *exact same* hospital portal by auto-detecting a unique patient identifier within the MyChart JSON payload.
*   **Custom Calendar Routing & Prefixes:** Allow users to map different MyChart accounts (Domain + Patient combos) to either the *same* Google Calendar (distinguished by custom prefixes like `[Mom]` or `[Child]`) or map them to completely *different* Google Calendars.
*   **High-Fidelity Data Extraction:** Intercept the native background network requests (XHR/Fetch) made by the MyChart web application to extract exact appointment details (Provider, Time, Location) with zero API rate limits to worry about.
*   **Automated Syncing:** Automatically push intercepted appointments to the user's designated Google Calendar using the Google Calendar API.
*   **Privacy & Security First:** No credentials (username/password) are needed or stored by the extension. Patient data strictly flows from the browser directly to the user's Google Calendar without any intermediate centralized servers.
*   **Reliable Change Detection:** Identify new, updated, and canceled appointments when the user visits the portal, keeping the Google Calendar perfectly up to date.

## 2.1 Chrome Extension Gotchas & Mitigations
*   **Manifest V3 Limitations:** Chrome's Manifest V3 heavily restricts background persistent processes. Service workers can be terminated aggressively.
    *   *Mitigation:* Use alarms for background polling (if applicable, though our core trigger is user navigation) and rely heavily on `chrome.storage.local` to persist the sync state so the worker can pick up where it left off upon waking up.
*   **Content Security Policy (CSP):** The MyChart portal may have strict CSP rules preventing external script injections or XHR requests to unapproved domains.
    *   *Mitigation:* Do not make API calls directly from the content script injected into the MyChart page. The content script should only *intercept* the local payload and pass the JSON via `chrome.runtime.sendMessage` to the background Service Worker. The Service Worker is exempt from the page's CSP and can securely communicate with the Google Calendar API.
*   **DOM/API Volatility:** MyChart is a proprietary system; the hospital or Epic can change the internal JSON structure or the URL route of the "Visits" page at any time without warning.
    *   *Mitigation:* Fail gracefully. Wrap the parsing logic in `try/catch` and rely on a robust, versioned schema matcher. If the payload structure is unrecognized, alert the user via a clear UI badge ("Sync failed: MyChart updated its format. Please wait for an extension update."). Avoid brittle DOM scraping entirely; only rely on the intercepted JSON.
*   **CORS Restrictions:** Making direct requests to Google APIs from content scripts can trigger Cross-Origin Resource Sharing blocks.
    *   *Mitigation:* All external network calls (to Google Calendar) must route exclusively through the background Service Worker.

## 3. Technical Architecture

### 3.1 Environment & Platform
*   **Platform:** Browser Extension (Manifest V3 for Chrome/Edge or equivalent for Firefox/Safari).
*   **State Management:** `chrome.storage.local` to securely store the Google OAuth token, target Calendar ID, and a local cache of previously synchronized Epic appointment IDs.
*   **Execution Model:** 
    *   **Background Service Worker:** Handles the OAuth flow with Google, listens to extension events, and manages the Google Calendar API calls.
    *   **Content Scripts / Network Interception:** `chrome.debugger` API, `chrome.webRequest` (where supported), or injected scripts overriding `fetch`/`XMLHttpRequest` to seamlessly capture the raw JSON payloads returned by MyChart's internal API when the user views the "Upcoming Visits" page.

### 3.2 Data Source (MyChart Internal API)
*   **Endpoint:** The internal, undocumented MyChart endpoints utilized by the SPA (Single Page Application), typically returning JSON containing the upcoming visits list.
*   **Authentication:** Handled natively by the user. The user simply logs into MyChart as they normally would. The extension piggybacks on the existing authenticated session cookies, bypassing any need for complex OAuth or 2FA handshakes.
*   **Data Extraction Method:** Instead of scraping HTML (which is notoriously brittle to UI updates), the extension intercepts the HTTP responses. This guarantees structured data extraction.

### 3.3 Destinations (Google Services)
*   **Calendar:** Google Calendar API. The background script uses the `chrome.identity` API to get an OAuth Auth Token for `https://www.googleapis.com/auth/calendar.events` and interacts solely with the specific target calendar selected by the user.

## 4. Functional Requirements

### 4.1 Setup & Configuration
*   **Google Auth:** The extension popup must feature a "Sign in with Google" button utilizing `chrome.identity.getAuthToken`.
*   **Multi-Account Patient Profiles:** The popup UI manages a list of "Sync Profiles". Each profile uniquely maps a `[Hostname + PatientIdentifier]` combination to:
    1.  A specific **Target Google Calendar**.
    2.  An **Event Title Prefix** (e.g., `[Dad]` or `[Child]`) so events on a shared calendar can be easily distinguished.
*   **Context-Aware Configuration:** When the user clicks the extension icon while physically browsing a MyChart portal, the popup automatically detects the current hostname *and* scrapes/extracts the current patient's name or ID from the active DOM or intercepted JSON, prompting the user to configure the Prefix and Target Calendar specifically for that individual on that hospital's domain.

### 4.2 Sync Engine Phase
1.  **Trigger:** The syncing mechanism remains dormant until the user navigates to the "Visits" or "Upcoming Appointments" page on a recognized MyChart domain.
2.  **Intercept:** The extension silently captures the JSON response from the internal MyChart API that populates the page.
3.  **Parse:** Extract relevant details from the internal JSON structure:
    *   Start time & End time.
    *   Provider Name.
    *   Location/Address.
    *   Appointment ID (crucial for deduplication).
4.  **Diffing & Deduplication:**
    *   The extension checks `chrome.storage.local` for previously synced Appointment IDs.
    *   It fetches future events from the Google Calendar (filtered by an extended property or title tag containing the Epic Appointment ID).
    *   **Create:** New appointments found in the MyChart JSON are pushed to Google Calendar.
    *   **Update:** If the time or location differs from the cached version, the existing Google Calendar event is updated.
    *   **Cancel:** If a previously synced appointment (known to be in the future) is no longer present in the MyChart JSON, the extension updates the target Google Calendar event title to prepend `[CANCELED]` and sets to "Free" time, freeing up the calendar slot.
5.  **Confirmation:** The extension injects a small, non-intrusive Toast notification into the MyChart UI (e.g., "EpicSyncCal: Successfully synced 3 appointments to Google Calendar") to assure the user the sync worked.

### 4.3 Data Retrieval Scenarios
The extension must accurately handle various ways a user might interact with MyChart to ensure the payload is captured:
1.  **Direct Navigation:** User logs in and lands directly on the dashboard containing upcoming visits (initial page load). *Action: Intercept initial hydration payload if present in the HTML or immediate XHR requests.*
2.  **SPA Routing:** User logs in, lands on the home page, and clicks the "Visits" tab. The page doesn't fully reload, but a background XHR request is fired. *Action: Content script observes network requests via `hook` on `fetch`/`XHR`.*
3.  **Pagination/Infinite Scroll:** If the user has many future appointments, MyChart might paginate the JSON payload. *Action: The background script must uniquely merge payloads based on Appointment ID before calculating the diffs.*
4.  **Cached Responses:** The browser or MyChart SPA might serve a cached JSON response if the user navigates back and forth quickly. *Action: Process the payload anyway; the diff engine will realize no changes are needed against the Google Calendar state and cleanly exit.*

### 4.4 Gaps & Edge Cases to Handle
*   **Multi-Account/Proxy Access (The Same-Domain Problem):** A user might have two logins (or standard Proxy Access) for the *exact same* hospital domain (e.g., `mychart.nyulangone.org`). The extension must analyze the intercepted JSON payload to find a unique `PatientID` or `PatientName` to disambiguate the data so that it applies the correct routing/prefix profile entirely autonomously. Simply relying on the `hostname` is insufficient for this proxy access use case.
*   **Timezone Discrepancies:** The hospital's server timezone, the timezone in the JSON payload, and the user's local browser timezone might differ. Ensure all DateTime strings are strictly parsed according to the offset provided by the MyChart JSON (e.g., ISO8601 with explicit offsets) to prevent events from appearing hours off schedule on Google Calendar.
*   **Deleted Target Calendar:** The user might delete the specific Google Calendar they selected in the extension. *Handling:* The extension should catch the `404 Not Found` from the Google API, abort the sync, and show a clear error badge on the extension icon prompting the user to re-select a destination calendar.
*   **Session Timeout:** The MyChart session expires, but the user leaves the tab open. Poking around might trigger 401 Unauthorized XHR requests. *Handling:* The script should safely ignore failed internal API requests and do nothing until a successful 200 OK JSON payload is intercepted.
*   **Missing Fields:** An appointment might not have a provider assigned yet, or the location might be "TBD". Provide graceful fallbacks (e.g., "Location: Details pending in MyChart").

### 4.5 User Experience (UX) & Simplicity
*   **"Set It and Forget It" Flow:**
    1.  User installs the extension.
    2.  User clicks the extension icon once.
    3.  A popup shows: "1. Authenticate with Google" -> User clicks button.
    4.  Popup updates: "2. Select Calendar" -> User selects from a dropdown.
    5.  Popup updates: "All Set! Just log into your hospital's MyChart portal normally, and we'll handle the rest."
*   **Zero Confusing Inputs:** Do not ask the user for "FHIR Endpoints", "Client IDs", or complex regex patterns. 
*   **Auto-Discovery:** Whenever the user successfully logs into a domain containing `mychart` (e.g., `https://mychart.hospital.org/MyChart/`), the background script should detect the successful login/navigation and automatically flag that domain as an active sync target without the user having to manually type in the URL.
*   **Visual Feedback:** When a sync occurs, change the extension icon to a green checkmark momentarily. Use browser notifications (`chrome.notifications`) only for errors (e.g., "Google Auth Expired - Please click here to re-login").

## 5. Implementation Phases

### Phase 1: Google Cloud Setup
1.  Create a project in the Google Cloud Console.
2.  Enable the Google Calendar API.
3.  Configure the OAuth Consent Screen (Internal/Testing mode is completely fine since this is strictly for personal use).
4.  Create an OAuth 2.0 Client ID for a "Chrome App/Extension" to obtain the necessary Client ID for the extension manifest.

### Phase 2: Extension Scaffold & Auth
1.  Initialize a Manifest V3 Chrome Extension project.
2.  Design a minimal Popup UI (HTML/CSS/JS) for logging in and selecting the target calendar.
3.  Implement `chrome.identity.getAuthToken` to handle the Google Sign-In and retrieve the access token securely.

### Phase 3: MyChart Payload Interception
1.  Log into the target MyChart portal with DevTools open.
2.  Navigate to "Visits" and track identical network traffic to identify the precise internal API endpoint and JSON structure returning the appointment data.
3.  Implement a Content Script that injects a payload interceptor (overriding `fetch` prototype or using standard WebExtensions features) to capture this JSON transparently when the user visits the page.

### Phase 4: Calendar Sync Logic
1.  Map the internal MyChart JSON keys to a normalized `Appointment` JavaScript object.
2.  Implement the Google Calendar API `insert`, `update`, and `get` wrapper in the Background Service Worker.
3.  Develop the synchronization diff logic to compare the normalized appointments against what is currently on the Google Calendar, avoiding duplicates.

### Phase 5: Multi-Account & Proxy Support
1.  Developed a DOM scraper in `content.js` to extract the `PatientName` from the "Welcome" header upon login, effectively solving the Same-Domain Proxy problem.
2.  Updated `chrome.storage.local` to use a composite key consisting of `Hostname-PatientName` to map distinct profiles to different Google Calendars and prefixes.
3.  Upgraded the Popup UI to be context-aware, populating the active domain and the actively scraped patient name automatically.

### Phase 6: Testing & Usage
1.  Load the extension locally in Chrome via `chrome://extensions` ("Developer Mode").
2.  Manually log into MyChart and navigate to the visits page.
3.  Verify the Toast notification appears and events correctly populate the target Google Calendar.
4.  *(Ongoing Use)*: Syncing occurs effortlessly anytime the user checks their appointments in the portal.
