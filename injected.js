(function () {
    const originalFetch = window.fetch;

    window.fetch = async function (...args) {
        const url = args[0] instanceof Request ? args[0].url : args[0];

        // MyChart typically hits internal endpoints ending in /api/Appointments or similar for upcoming visits
        const isVisitsEndpoint = typeof url === 'string' &&
            (url.toLowerCase().includes('/api/appointments') ||
                url.toLowerCase().includes('/api/visits') ||
                url.toLowerCase().includes('upcomingvisits') ||
                url.toLowerCase().includes('/visits'));

        const response = await originalFetch.apply(this, args);

        if (isVisitsEndpoint) {
            try {
                const clonedResponse = response.clone();
                const data = await clonedResponse.json();

                // Send the intercepted data back out to the isolated content script via window.postMessage
                window.postMessage({
                    type: 'EPIC_SYNC_CAL_PAYLOAD',
                    payload: data
                }, '*');

                console.log("EpicSyncCal (Injected): Intercepted upcoming visits payload.");
            } catch (e) {
                // Not all JSON responses on these endpoints are the appointment payload
            }
        }

        return response;
    };

    // Also hook XMLHttpRequest if this specific MyChart instance is older
    const originalXHR = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.addEventListener('load', function () {
            if (typeof url === 'string' &&
                (url.toLowerCase().includes('/api/appointments') ||
                    url.toLowerCase().includes('/api/visits') ||
                    url.toLowerCase().includes('upcomingvisits') ||
                    url.toLowerCase().includes('/visits'))) {
                try {
                    const data = JSON.parse(this.responseText);
                    window.postMessage({
                        type: 'EPIC_SYNC_CAL_PAYLOAD',
                        payload: data
                    }, '*');
                    console.log("EpicSyncCal (Injected XHR): Intercepted upcoming visits payload.");
                } catch (e) { }
            }
        });
        return originalXHR.call(this, method, url, ...rest);
    };
})();
