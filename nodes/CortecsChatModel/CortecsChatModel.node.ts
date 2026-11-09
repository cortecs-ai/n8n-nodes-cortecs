import { supplyModel } from '@n8n/ai-node-sdk';
import type {
	ILoadOptionsFunctions,
	INodeListSearchResult,
	INodeType,
	INodeTypeDescription,
	INodeParameterResourceLocator,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { httpStatus, requestGuidance } from './errors';

const BASE_URL = 'https://api.cortecs.ai/v1';

interface CortecsModel {
	id: string;
	description?: string;
	input_modalities?: string[];
	output_modalities?: string[];
	supported_features?: string[];
}

export class CortecsChatModel implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Cortecs Chat Model',
		name: 'cortecsChatModel',
		icon: { light: 'file:cortecs.png', dark: 'file:cortecs.png' },
		subtitle: '={{$parameter.model.value}}',
		group: ['transform'],
		version: 1,
		description: 'Use Cortecs chat models with AI agents and chains',
		defaults: { name: 'Cortecs Chat Model' },
		codex: { categories: ['AI'], subcategories: { AI: ['Language Models'] } },
		inputs: [],
		outputs: [NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Model'],
		credentials: [{ name: 'cortecsApi', required: true }],
		properties: [
			{
				displayName: 'Model',
				name: 'model',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				description: 'Choose a model. For AI agents, select a model with tool support.',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: { searchListMethod: 'getModels', searchable: true },
					},
					{ displayName: 'By ID', name: 'id', type: 'string', placeholder: 'e.g. kolibri-1' },
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Maximum Output Tokens',
						name: 'maxTokens',
						type: 'number',
						default: 1024,
						typeOptions: { minValue: 1, numberPrecision: 0 },
						description:
							'Maximum number of tokens to generate. Leave unset to use the model default.',
					},
					{
						displayName: 'Temperature',
						name: 'temperature',
						type: 'number',
						default: 0.7,
						typeOptions: { minValue: 0, maxValue: 2 },
						description:
							'Sampling temperature, if supported by the model. Leave unset to use the model default.',
					},
				],
			},
		],
	};

	methods = {
		listSearch: {
			async getModels(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				try {
					const response = (await this.helpers.httpRequestWithAuthentication.call(
						this,
						'cortecsApi',
						{
							method: 'GET',
							url: `${BASE_URL}/models`,
							json: true,
						},
					)) as { data: CortecsModel[] };
					const query = filter?.toLowerCase() ?? '';
					return {
						results: response.data
							.filter(
								(model) =>
									model.input_modalities?.includes('text') &&
									model.output_modalities?.includes('text'),
							)
							.filter((model) => model.id.toLowerCase().includes(query))
							.sort((a, b) => a.id.localeCompare(b.id))
							.map((model) => ({
								name: model.supported_features?.includes('tools')
									? `${model.id} (Tools)`
									: model.id,
								value: model.id,
								description: model.description,
							})),
					};
				} catch (error: unknown) {
					const status = httpStatus(error);
					throw new NodeApiError(
						this.getNode(),
						{},
						{
							message: 'Could not load Cortecs models',
							description: `${requestGuidance(status)} You can also choose 'By ID' in 'Model' and enter a known model ID.`,
							httpCode: status?.toString(),
						},
					);
				}
			},
		},
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = await this.getCredentials('cortecsApi');
		const locator = this.getNodeParameter('model', itemIndex) as INodeParameterResourceLocator;
		const model = String(locator.value ?? '').trim();
		if (!model) {
			throw new NodeOperationError(this.getNode(), "The 'Model' parameter is empty", {
				itemIndex,
				description:
					"Select a model from 'From List', or choose 'By ID' and enter a Cortecs model ID.",
			});
		}
		const options = this.getNodeParameter('options', itemIndex, {}) as {
			temperature?: number;
			maxTokens?: number;
		};
		if (
			options.temperature !== undefined &&
			(!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)
		) {
			throw new NodeOperationError(
				this.getNode(),
				"The 'Temperature' value is outside the supported range",
				{
					itemIndex,
					description:
						"Enter a number between 0 and 2, or remove 'Temperature' from 'Options' to use the model default.",
				},
			);
		}
		if (
			options.maxTokens !== undefined &&
			(!Number.isInteger(options.maxTokens) || options.maxTokens < 1)
		) {
			throw new NodeOperationError(
				this.getNode(),
				"The 'Maximum Output Tokens' value is not a positive integer",
				{
					itemIndex,
					description:
						"Enter a whole number of at least 1, or remove 'Maximum Output Tokens' from 'Options' to use the model default.",
				},
			);
		}
		return supplyModel(this, {
			type: 'openai',
			baseUrl: BASE_URL,
			apiKey: String(credentials.apiKey),
			model,
			useResponsesApi: false,
			supportsStrictToolCalling: false,
			temperature: options.temperature,
			maxTokens: options.maxTokens,
		});
	}
}
