'use strict';

import path from 'node:path';
import { ChatwootService } from './chatwoot.js';
import { WhatsAppService } from './whatsapp.js';

function parseBoolean(value, fallback = false) {
	if (value === undefined || value === null || value === '') return fallback;
	if (typeof value === 'boolean') return value;
	switch (String(value).trim().toLowerCase()) {
	case '1':
	case 'true':
	case 'yes':
	case 'on':
		return true;
	case '0':
	case 'false':
	case 'no':
	case 'off':
		return false;
	default:
		return fallback;
	}
}

const INTEGRATION_ENV_PREFIXES = new Set([
	'CHATWOOT_ACCOUNT_ID',
	'CHATWOOT_INBOX_NAME',
	'REABRIR_CONVERSA',
	'DESCONSIDERAR_GRUPO',
	'ASSINAR_MENSAGEM',
	'APP_DATA_FILE',
	'DEFAULT_COUNTRY',
	'CONVERSATION_STATUS',
	'UAZAPI_BASE_URL',
	'UAZAPI_TOKEN',
	'UAZAPI_WHATSAPP',
	'ZAPI_INSTANCIA',
	'ZAPI_TOKEN_INSTANCIA',
	'ZAPI_CLIENT_TOKEN',
	'ZAPI_WEBHOOK_URL',
	'WUZAPI_BASE_URL',
	'WUZAPI_TOKEN'
]);

function detectIntegrationIds() {
	const ids = new Set();

	if (process.env.INTEGRATIONS) {
		process.env.INTEGRATIONS.split(',').map((id) => id.trim()).filter(Boolean).forEach((id) => ids.add(id));
	}

	for (const key of Object.keys(process.env)) {
		const match = key.match(/^(.*)_(\d+)$/);
		if (!match) continue;
		const base = match[1];
		const idx = match[2];
		if (INTEGRATION_ENV_PREFIXES.has(base)) {
			ids.add(idx);
		}
	}

	return Array.from(ids).sort((a, b) => Number(a) - Number(b));
}

function getEnvValue(baseName, id) {
	if (id) {
		const withIndex = process.env[`${baseName}_${id}`];
		if (withIndex !== undefined) {
			return withIndex;
		}
	}
	return process.env[baseName];
}

function buildChatwootConfig(id) {
	const baseURL = (getEnvValue('CHATWOOT_BASE_URL', id) || '').trim();
	const apiToken = getEnvValue('CHATWOOT_API_TOKEN', id);
	const accountId = getEnvValue('CHATWOOT_ACCOUNT_ID', id);
	const inboxName = getEnvValue('CHATWOOT_INBOX_NAME', id);
	if (!baseURL || !apiToken || !accountId || !inboxName) {
		throw new Error(`Configuração do Chatwoot incompleta para integração ${id || 'padrão'}. Verifique CHATWOOT_BASE_URL/CHATWOOT_API_TOKEN/CHATWOOT_ACCOUNT_ID/CHATWOOT_INBOX_NAME.`);
	}

	const webhookBaseURL = (getEnvValue('WEBHOOK_BASE_URL', id) || process.env.WEBHOOK_BASE_URL || '').trim();
	const webhookName = getEnvValue('WEBHOOK_NAME', id) || process.env.WEBHOOK_NAME || 'wootrico';

	const dataFileFromEnv = getEnvValue('APP_DATA_FILE', id) || process.env.APP_DATA_FILE;
	const dataFilePath = dataFileFromEnv
		? dataFileFromEnv
		: path.join('/app/data', `app-data-${accountId}-${inboxName}.json`);

	// Valida e define o status da conversa (open, resolved, pending)
	const conversationStatusRaw = getEnvValue('CONVERSATION_STATUS', id) || process.env.CONVERSATION_STATUS || 'open';
	const validStatuses = ['open', 'resolved', 'pending'];
	const conversationStatus = validStatuses.includes(conversationStatusRaw.toLowerCase()) 
		? conversationStatusRaw.toLowerCase() 
		: 'open';

	return {
		id: id || 'default',
		baseURL,
		apiToken,
		accountId: String(accountId),
		inboxName,
		webhookBaseURL,
		webhookName,
		dataFilePath,
		reabrirConversa: parseBoolean(getEnvValue('REABRIR_CONVERSA', id), parseBoolean(process.env.REABRIR_CONVERSA, true)),
		defaultCountry: getEnvValue('DEFAULT_COUNTRY', id) || process.env.DEFAULT_COUNTRY || 'BR',
		desconsiderarGrupo: parseBoolean(getEnvValue('DESCONSIDERAR_GRUPO', id), parseBoolean(process.env.DESCONSIDERAR_GRUPO, true)),
		assinarMensagem: parseBoolean(getEnvValue('ASSINAR_MENSAGEM', id), parseBoolean(process.env.ASSINAR_MENSAGEM, true)),
		conversationStatus
	};
}

function buildWhatsAppConfig(id) {
	const uazToken = getEnvValue('UAZAPI_TOKEN', id);
	const uazBase = getEnvValue('UAZAPI_BASE_URL', id);
	const uazNumber = getEnvValue('UAZAPI_WHATSAPP', id);

	if (uazToken && uazBase && uazNumber) {
		return {
			id: id || 'default',
			provider: 'uazapi',
			baseURL: uazBase,
			token: uazToken,
			whatsappNumber: String(uazNumber).replace(/[^0-9]/g, '')
		};
	}

	const zapiInstance = getEnvValue('ZAPI_INSTANCIA', id);
	const zapiToken = getEnvValue('ZAPI_TOKEN_INSTANCIA', id);
	const zapiClientToken = getEnvValue('ZAPI_CLIENT_TOKEN', id);

	if (zapiInstance && zapiToken && zapiClientToken) {
		return {
			id: id || 'default',
			provider: 'zapi',
			instance: zapiInstance,
			token: zapiToken,
			clientToken: zapiClientToken
		};
	}

	const wuzBase = getEnvValue('WUZAPI_BASE_URL', id);
	const wuzToken = getEnvValue('WUZAPI_TOKEN', id);
	if (wuzBase && wuzToken) {
		return {
			id: id || 'default',
			provider: 'wuzapi',
			baseURL: wuzBase,
			token: wuzToken
		};
	}

	throw new Error(`Configuração de WhatsApp não encontrada para integração ${id || 'padrão'}.`);
}

export async function loadIntegrations() {
	try {
		const ids = detectIntegrationIds();
		const integrationIds = ids.length > 0 ? ids : [null];

		if (integrationIds.length === 0) {
			throw new Error('Nenhuma integração detectada. Configure pelo menos uma integração usando variáveis de ambiente.');
		}

		console.log(`Detectadas ${integrationIds.length} integração(ões): ${integrationIds.join(', ')}`);

		const integrations = [];
		const errors = [];

		for (const id of integrationIds) {
			try {
				const integrationName = id || 'default';
				console.log(`Carregando integração: ${integrationName}...`);
				
				const chatwootConfig = buildChatwootConfig(id);
				const whatsappConfig = buildWhatsAppConfig(id);

				const chatwootService = new ChatwootService({
					...chatwootConfig
				});

				const whatsappService = new WhatsAppService({
					...whatsappConfig
				});

				if (whatsappService.provider === 'uazapi' && typeof whatsappService.downloadUazapiMedia === 'function') {
					chatwootService.setDownloadUazapiMediaFn((messageId) => whatsappService.downloadUazapiMedia(messageId));
				}

				console.log(`Inicializando inbox para integração ${integrationName}...`);
				await chatwootService.ensureInbox();

				const integration = {
					id: chatwootConfig.id,
					chatwoot: chatwootService,
					whatsapp: whatsappService,
					defaultCountry: chatwootConfig.defaultCountry,
					desconsiderarGrupo: chatwootConfig.desconsiderarGrupo,
					assinarMensagem: chatwootConfig.assinarMensagem
				};

				integrations.push(integration);
				console.log(`✓ Integração ${integrationName} carregada com sucesso - Inbox ID: ${chatwootService.inboxId}, Provider: ${whatsappConfig.provider}`);
			} catch (error) {
				const integrationName = id || 'default';
				const errorMsg = error?.message || 'Erro desconhecido';
				console.error(`✗ Erro ao carregar integração ${integrationName}: ${errorMsg}`);
				errors.push({ id, error: errorMsg });
			}
		}

		if (integrations.length === 0) {
			const errorDetails = errors.map(e => `  - Integração ${e.id || 'default'}: ${e.error}`).join('\n');
			throw new Error(`Nenhuma integração foi carregada com sucesso.\nErros encontrados:\n${errorDetails}`);
		}

		if (errors.length > 0) {
			console.warn(`Aviso: ${errors.length} integração(ões) falharam ao carregar, mas ${integrations.length} integração(ões) foram carregadas com sucesso.`);
		}

		console.log(`\n=== Integrações Carregadas: ${integrations.length} ===`);
		integrations.forEach(integration => {
			console.log(`  ${integration.id}: ${integration.whatsapp.provider} - Inbox: ${integration.chatwoot.inboxId || 'não inicializado'}`);
		});
		console.log('=====================================\n');

		return integrations;
	} catch (error) {
		console.error('Erro fatal ao carregar integrações:', error?.message || error);
		throw error;
	}
}

export function findIntegrationByInboxId(integrations, inboxId) {
	if (!inboxId) return null;
	return integrations.find((integration) => {
		const integrationInboxId = integration.chatwoot?.inboxId;
		return integrationInboxId && String(integrationInboxId) === String(inboxId);
	});
}

export function findIntegrationById(integrations, id) {
	return integrations.find((integration) => integration.id === String(id));
}

export function findIntegrationByWhatsAppIdentifier(integrations, provider, identifier) {
	if (!identifier) return null;
	return integrations.find((integration) => {
		if (integration.whatsapp.provider !== provider) return false;
		if (provider === 'uazapi') {
			const normalizedIdentifier = String(identifier).replace(/[^0-9]/g, '');
			return integration.whatsapp.normalizedNumber === normalizedIdentifier;
		}
		if (provider === 'zapi') {
			return integration.whatsapp.instance === identifier;
		}
		if (provider === 'wuzapi') {
			return (integration.whatsapp.baseURL || '').toLowerCase() === (identifier || '').toLowerCase();
		}
		return false;
	});
}

