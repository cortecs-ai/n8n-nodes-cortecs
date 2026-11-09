export function requestGuidance(status?: number): string {
	switch (status) {
		case 401:
			return "Cortecs did not accept the API key. Check the 'API Key' in your Cortecs API credential, or create a new key in the Cortecs console.";
		case 402:
			return 'Cortecs requires payment before completing this request. Check your balance and billing in the Cortecs console, then try again.';
		case 403:
			return 'Cortecs denied access to this request. Check your API key permissions and IP restrictions in the Cortecs console.';
		case 404:
			return 'Cortecs could not find the requested endpoint or model. Refresh the model list and try again; if this continues, contact Cortecs support.';
		case 429:
			return 'Cortecs is limiting requests. Wait before trying again and check your usage limits in the Cortecs console.';
		default:
			if (status !== undefined && status >= 500) {
				return 'Cortecs is temporarily unable to complete the request. Try again later; if this continues, contact Cortecs support.';
			}
			return 'Could not complete the Cortecs request. Check your connection, API key, balance, IP restrictions, and service availability, then try again.';
	}
}

export function httpStatus(error: unknown): number | undefined {
	if (typeof error !== 'object' || error === null) return undefined;
	const details = error as {
		status?: unknown;
		statusCode?: unknown;
		httpCode?: unknown;
		response?: { status?: unknown };
	};
	const value = Number(
		details.statusCode ?? details.status ?? details.httpCode ?? details.response?.status,
	);
	return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}
