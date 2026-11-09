import type {
	IAuthenticate,
	IHttpRequestOptions,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';
import { OperationalError } from 'n8n-workflow';
import { httpStatus, requestGuidance } from '../nodes/CortecsChatModel/errors';

const BASE_URL = 'https://api.cortecs.ai/v1';
const TEST_HEADER = 'X-N8N-Cortecs-Credential-Test';

export class CortecsApi implements ICredentialType {
	name = 'cortecsApi';
	displayName = 'Cortecs API';
	documentationUrl = 'https://docs.cortecs.ai/';
	icon = {
		light: 'file:../nodes/CortecsChatModel/cortecs.png',
		dark: 'file:../nodes/CortecsChatModel/cortecs.png',
	} as const;
	httpRequestNode = {
		name: 'Cortecs',
		docsUrl: 'https://docs.cortecs.ai/api',
		apiBaseUrl: 'https://api.cortecs.ai/v1',
	};
	properties: INodeProperties[] = [
		{
			displayName:
				'Testing credentials sends a one-token chat request and may incur a small charge.',
			name: 'testNotice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
		},
	];
	// The Creator Portal expects a declarative test on the credential itself.
	// Mark only this request for dynamic model selection; normal authenticated
	// HTTP requests receive the API key without any additional requests.
	test: ICredentialTestRequest = {
		request: {
			baseURL: BASE_URL,
			url: '/chat/completions',
			method: 'POST',
			headers: { [TEST_HEADER]: 'true' },
			body: { messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 },
			timeout: 30000,
		},
		rules: [401, 402, 403, 404, 429, 500, 502, 503, 504].map((status) => ({
			type: 'responseCode' as const,
			properties: { value: status, message: requestGuidance(status) },
		})),
	};

	authenticate: IAuthenticate = async (credentials, requestOptions) => {
		const headers: NonNullable<IHttpRequestOptions['headers']> = {
			...requestOptions.headers,
			Authorization: `Bearer ${String(credentials.apiKey ?? '')}`,
		};
		const testHeader = Object.keys(headers).find(
			(name) => name.toLowerCase() === TEST_HEADER.toLowerCase(),
		);
		if (!testHeader || headers[testHeader] !== 'true') return { ...requestOptions, headers };
		delete headers[testHeader];
		try {
			// /models is public, even for invalid keys, so the actual credential
			// test must complete an authenticated generation request as well.
			const response = await fetch(`${BASE_URL}/models`, {
				headers: { Authorization: String(headers.Authorization) },
				signal: AbortSignal.timeout(30000),
			});
			if (!response.ok) throw new OperationalError(requestGuidance(response.status));
			const catalog = (await response.json()) as {
				data: {
					id: string;
					input_modalities?: string[];
					output_modalities?: string[];
					supported_features?: string[];
					pricing?: { output_token?: number };
				}[];
			};
			const candidates = catalog.data.filter(
				(model) =>
					model.input_modalities?.includes('text') &&
					model.output_modalities?.includes('text') &&
					!model.supported_features?.includes('reasoning'),
			);
			candidates.sort(
				(a, b) => (a.pricing?.output_token ?? Infinity) - (b.pricing?.output_token ?? Infinity),
			);
			if (!candidates.length)
				throw new OperationalError(
					'No text model without reasoning is available for the credential test. Try again later; if this continues, contact Cortecs support.',
				);
			return {
				...requestOptions,
				headers,
				body: { ...(requestOptions.body as object), model: candidates[0].id },
			};
		} catch (error: unknown) {
			if (error instanceof OperationalError) throw error;
			throw new OperationalError(
				error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
					? 'The Cortecs credential test timed out. Check your connection and Cortecs service availability, then try again.'
					: requestGuidance(httpStatus(error)),
			);
		}
	};
}
