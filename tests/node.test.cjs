const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { CortecsChatModel } = require('../dist/nodes/CortecsChatModel/CortecsChatModel.node');
const { CortecsApi } = require('../dist/credentials/CortecsApi.credentials');
const node = new CortecsChatModel();
const baseUrl = process.env.CORTECS_TEST_BASE_URL;
function context(parameters = {}, key = 'local-test-key') {
	return {
		getCredentials: async () => ({ apiKey: key }),
		getNode: () => ({ name: 'Cortecs', typeVersion: 1, parameters: {}, type: 'cortecsChatModel' }),
		getNodeParameter: (name, index, fallback) => parameters[name] ?? fallback,
		helpers: {
			getSecureEgressFilter: () => ({
				createSecureLookup: () => require('node:dns').lookup,
				assertAllowed: async () => {},
				validateUrl: async () => ({ ok: true }),
				validateConnectionHost: () => ({ ok: true }),
			}),
		},
	};
}
async function modelFor(parameters, key) {
	const { response } = await node.supplyData.call(context(parameters, key), 0);
	return response;
}
// Drive the credential-level declaration through the same authenticate/request
// order as n8n. Provider calls still run against the local HTTP fixture.
async function runCredentialTest(_context, credentialData) {
	const credential = new CortecsApi();
	try {
		const options = await credential.authenticate(
			credentialData.data,
			structuredClone(credential.test.request),
		);
		const response = await fetch(`${options.baseURL}${options.url}`, {
			method: options.method,
			headers: { 'Content-Type': 'application/json', ...options.headers },
			body: JSON.stringify(options.body),
		});
		await response.text();
		const rule = credential.test.rules.find((rule) => rule.properties.value === response.status);
		return response.ok
			? { status: 'OK' }
			: {
					status: 'Error',
					message: rule?.properties.message ?? 'Check your connection and Cortecs configuration',
				};
	} catch (error) {
		return { status: 'Error', message: error.message };
	}
}
test('credential declares a portal-visible test and authenticates normal requests without inference', async () => {
	const credential = new CortecsApi();
	assert.equal(credential.properties.find((p) => p.name === 'apiKey').typeOptions.password, true);
	assert.equal(credential.test.request.method, 'POST');
	assert.equal(credential.test.request.url, '/chat/completions');
	assert.equal(credential.test.request.body.max_tokens, 1);
	const stub = mock.method(globalThis, 'fetch', () => {
		throw new Error('Normal requests must not trigger model discovery');
	});
	try {
		const request = {
			method: 'POST',
			url: 'https://api.cortecs.ai/v1/chat/completions',
			headers: { 'X-Custom': 'value' },
			body: { model: 'chosen-by-user' },
		};
		const result = await credential.authenticate({ apiKey: 'local-test-key' }, request);
		assert.equal(result.headers.Authorization, 'Bearer local-test-key');
		assert.equal(result.headers['X-Custom'], 'value');
		assert.deepEqual(result.body, request.body);
	} finally {
		stub.mock.restore();
	}
});
test('node supplies the Cortecs model with provider defaults left unset', async () => {
	const model = await modelFor({ model: { mode: 'id', value: 'text-model' } });
	assert.equal(model.model, 'text-model');
	assert.equal(model.clientConfig.baseURL, 'https://api.cortecs.ai/v1');
	assert.equal(model.useResponsesApi, false);
	assert.equal(model.temperature, undefined);
});
test('rejects empty IDs and invalid generation settings', async () => {
	for (const [parameters, field, recovery] of [
		[{ model: { value: ' ' } }, 'Model', /By ID/],
		[{ model: { value: 'x' }, options: { temperature: 3 } }, 'Temperature', /between 0 and 2/],
		[
			{ model: { value: 'x' }, options: { maxTokens: -1 } },
			'Maximum Output Tokens',
			/whole number/,
		],
	])
		await assert.rejects(
			() => modelFor(parameters),
			(error) => {
				assert.ok(error.message.includes(`'${field}'`));
				assert.match(error.description, recovery);
				return true;
			},
		);
});

test('model discovery gives recovery guidance without exposing raw request details', async () => {
	for (const failure of [
		{ statusCode: 401 },
		{ response: { status: 503 } },
		new Error('Network request containing secret-test-key'),
	]) {
		const ctx = context();
		ctx.helpers.httpRequestWithAuthentication = async () => {
			throw failure;
		};
		await assert.rejects(
			() => node.methods.listSearch.getModels.call(ctx),
			(error) => {
				assert.equal(error.message, 'Could not load Cortecs models');
				assert.match(error.description, /By ID/);
				assert.ok(!JSON.stringify(error).includes('secret-test-key'));
				if (failure.statusCode === 401) assert.match(error.description, /API Key/);
				if (failure.response) assert.match(error.description, /Try again later/);
				return true;
			},
		);
	}
});

test('credential testing selects a model available to the authenticated account', async () => {
	const allowedModel = {
		id: 'allowed-model',
		input_modalities: ['text'],
		output_modalities: ['text'],
		pricing: { output_token: 1 },
	};
	const excludedModel = {
		...allowedModel,
		id: 'excluded-model',
		pricing: { output_token: 0.01 },
	};
	const requestedModels = [];
	const stub = mock.method(globalThis, 'fetch', async (url, options = {}) => {
		const authenticated = options.headers?.Authorization === 'Bearer restricted-test-key';
		if (String(url).endsWith('/models')) {
			return new Response(
				JSON.stringify({ data: authenticated ? [allowedModel] : [excludedModel, allowedModel] }),
			);
		}
		assert.equal(String(url), 'https://api.cortecs.ai/v1/chat/completions');
		assert.equal(options.headers['X-N8N-Cortecs-Credential-Test'], undefined);
		const { model } = JSON.parse(options.body);
		requestedModels.push(model);
		return new Response('{}', {
			status: authenticated && model === allowedModel.id ? 200 : 403,
		});
	});
	try {
		const result = await runCredentialTest({}, { data: { apiKey: 'restricted-test-key' } });
		assert.equal(result.status, 'OK');
		assert.deepEqual(requestedModels, ['allowed-model']);
	} finally {
		stub.mock.restore();
	}
});

test('credential testing gives status-specific guidance and handles timeouts safely', async () => {
	const catalog = {
		data: [{ id: 'text-model', input_modalities: ['text'], output_modalities: ['text'] }],
	};
	for (const [status, guidance] of [
		[401, /API Key/],
		[402, /balance and billing/],
		[403, /permissions and IP/],
		[404, /Refresh the model list/],
		[429, /Wait before trying again/],
		[503, /Try again later/],
		[400, /Check your connection/],
	]) {
		const stub = mock.method(
			globalThis,
			'fetch',
			async (url) =>
				new Response(
					JSON.stringify(String(url).endsWith('/models') ? catalog : { error: 'secret-test-key' }),
					{ status: String(url).endsWith('/models') ? 200 : status },
				),
		);
		try {
			const result = await runCredentialTest({}, { data: { apiKey: 'secret-test-key' } });
			assert.equal(result.status, 'Error');
			assert.match(result.message, guidance);
			assert.ok(!result.message.includes('secret-test-key'));
		} finally {
			stub.mock.restore();
		}
	}
	for (const failure of [
		new DOMException('secret-test-key', 'TimeoutError'),
		new Error('secret-test-key'),
	]) {
		const stub = mock.method(globalThis, 'fetch', async () => {
			throw failure;
		});
		try {
			const result = await runCredentialTest({}, { data: { apiKey: 'secret-test-key' } });
			assert.equal(result.status, 'Error');
			assert.match(
				result.message,
				failure.name === 'TimeoutError' ? /timed out/ : /Check your connection/,
			);
			assert.ok(!result.message.includes('secret-test-key'));
		} finally {
			stub.mock.restore();
		}
	}
});
test('resolves expression values at the supplied item index', async () => {
	const ctx = context({ options: { temperature: 0, maxTokens: 20 } });
	ctx.getNodeParameter = (name, index) => {
		assert.equal(index, 3);
		return name === 'model'
			? { mode: 'list', value: 'tool-model' }
			: { temperature: 0, maxTokens: 20 };
	};
	const { response } = await node.supplyData.call(ctx, 3);
	assert.equal(response.model, 'tool-model');
	assert.equal(response.temperature, 0);
	assert.equal(response.maxTokens, 20);
});
async function request(options) {
	assert.ok(baseUrl, 'Set CORTECS_TEST_BASE_URL to the local simulation');
	const path = new URL(options.url).pathname;
	const response = await fetch(`${baseUrl}${path}`, {
		method: options.method,
		headers: { 'Content-Type': 'application/json', ...options.headers },
		body: options.body ? JSON.stringify(options.body) : undefined,
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}
test('live catalog is searchable and excludes non-chat models', { skip: !baseUrl }, async () => {
	const ctx = {
		helpers: { httpRequestWithAuthentication: async (_name, options) => request(options) },
	};
	const all = await node.methods.listSearch.getModels.call(ctx);
	assert.deepEqual(
		all.results.map((m) => m.value),
		['text-model', 'tool-model'],
	);
	assert.equal(all.results[1].name, 'tool-model (Tools)');
	const filtered = await node.methods.listSearch.getModels.call(ctx, 'TOOL');
	assert.equal(filtered.results.length, 1);
});
test(
	'credential test makes an authenticated request and rejects an invalid key',
	{ skip: !baseUrl },
	async () => {
		const nativeFetch = globalThis.fetch;
		const redirect = mock.method(globalThis, 'fetch', (input, options) =>
			nativeFetch(`${baseUrl}${new URL(input).pathname}`, options),
		);
		try {
			assert.equal(
				(await runCredentialTest({}, { data: { apiKey: 'local-test-key' } })).status,
				'OK',
			);
			assert.equal((await runCredentialTest({}, { data: { apiKey: 'invalid' } })).status, 'Error');
		} finally {
			redirect.mock.restore();
		}
	},
);
async function localModel(id = 'text-model', key) {
	const model = await modelFor({ model: { mode: 'id', value: id } }, key);
	for (const adapter of [model, model.completions, model.responses]) {
		adapter.clientConfig.baseURL = `${baseUrl}/v1`;
		adapter.timeout = 3000;
		adapter.caller.maxRetries = 0;
	}
	model.callbacks = []; // n8n tracing needs the workflow execution engine.
	model.fields.callbacks = [];
	model.fields.configuration.baseURL = `${baseUrl}/v1`;
	model.fields.timeout = 3000;
	model.fields.maxRetries = 0;
	model.maxRetries = 0;
	model.timeout = 3000;
	return model;
}
test(
	'real SDK adapter generates text against the HTTP simulation',
	{ skip: !baseUrl },
	async () => {
		const model = await localModel();
		const response = await model.invoke('Hi');
		assert.equal(response.content, 'Hello from Cortecs');
		assert.equal(response.usage_metadata.total_tokens, 2);
	},
);
test('real SDK adapter consumes an SSE stream', { skip: !baseUrl }, async () => {
	const model = await localModel();
	let content = '';
	for await (const chunk of await model.stream('Hi')) content += chunk.content;
	assert.equal(content, 'Hello from Cortecs');
});
test('real SDK adapter supports a tool-call round trip', { skip: !baseUrl }, async () => {
	const model = await localModel('tool-model');
	const bound = model.bindTools([
		{
			type: 'function',
			function: {
				name: 'weather',
				description: 'Get weather',
				parameters: {
					type: 'object',
					properties: { city: { type: 'string' } },
					required: ['city'],
				},
			},
		},
	]);
	const first = await bound.invoke('Weather in Vienna?');
	assert.equal(first.tool_calls[0].name, 'weather');
	assert.deepEqual(first.tool_calls[0].args, { city: 'Vienna' });
	const final = await bound.invoke([
		['human', 'Weather in Vienna?'],
		first,
		{ role: 'tool', content: 'Sunny', tool_call_id: first.tool_calls[0].id },
	]);
	assert.equal(final.content, 'Hello from Cortecs');
});
test(
	'real SDK adapter surfaces authentication and unknown-model failures',
	{ skip: !baseUrl },
	async () => {
		await assert.rejects(
			async () => (await localModel('text-model', 'invalid')).invoke('Hi'),
			/Authorization failed|401/,
		);
		await assert.rejects(
			async () => (await localModel('missing-model')).invoke('Hi'),
			/404|Unknown model|not be found/,
		);
	},
);
