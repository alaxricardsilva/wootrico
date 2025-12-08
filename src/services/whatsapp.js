'use strict';

import axios from 'axios';

export class WhatsAppService {
	constructor(config) {
		this.provider = config.provider; // 'uazapi', 'zapi', 'wuzapi'
		
		if (this.provider === 'uazapi') {
			this.baseURL = (config.baseURL || '').replace(/\/$/, '');
			this.token = config.token;
			this.whatsappNumber = String(config.whatsappNumber || '').replace(/[^0-9]/g, '');
			this.normalizedNumber = this.whatsappNumber;
		} else if (this.provider === 'zapi') {
			this.instance = config.instance;
			this.token = config.token;
			this.clientToken = config.clientToken;
			this.baseURL = `https://api.z-api.io/instances/${this.instance}/token/${this.token}`;
		} else if (this.provider === 'wuzapi') {
			this.baseURL = (config.baseURL || '').replace(/\/$/, '');
			this.token = config.token;
		} else {
			throw new Error(`Provider não suportado: ${this.provider}`);
		}
	}

	async downloadUazapiMedia(messageId, timeoutMs = 60000) {
		if (this.provider !== 'uazapi') {
			throw new Error('downloadUazapiMedia só está disponível para UAZAPI');
		}
		
		const client = axios.create({
			baseURL: this.baseURL,
			headers: {
				'token': this.token,
				'Content-Type': 'application/json'
			},
			timeout: timeoutMs
		});

		const maxRetries = 5;
		const retryDelay = 2000;
		
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				console.log(`Tentativa ${attempt}/${maxRetries} - Baixando mídia UAZAPI para messageId: ${messageId}`);
				const payload = {
					id: messageId,
					return_base64: true,
					return_link: false
				};

				const { data } = await client.post('/message/download', payload);
				const base64Data = data.base64Data || '';
				
				if (base64Data) {
					console.log(`Mídia UAZAPI baixada com sucesso (${base64Data.length} caracteres)`);
					return base64Data;
				} else {
					throw new Error('Mídia ainda não disponível (base64Data vazio)');
				}
			} catch (error) {
				const is404 = error?.response?.status === 404;
				const is503 = error?.response?.status === 503;
				const is502 = error?.response?.status === 502;
				const isTimeout = error?.code === 'ECONNABORTED' || error?.message?.includes('timeout');
				const isEmptyData = error?.message?.includes('não disponível') || error?.message?.includes('vazio');
				const isLastAttempt = attempt === maxRetries;
				
				// Retry em caso de 404, 502, 503, timeout ou dados vazios
				const shouldRetry = (is404 || is503 || is502 || isTimeout || isEmptyData) && !isLastAttempt;
				
				if (shouldRetry) {
					console.log(`Erro na tentativa ${attempt} (${error?.response?.status || error?.message}) - Mídia ainda não processada. Aguardando ${retryDelay}ms antes da próxima tentativa...`);
					await new Promise(resolve => setTimeout(resolve, retryDelay));
					continue;
				}
				
				console.error(`Erro ao baixar mídia UAZAPI para messageId ${messageId} (tentativa ${attempt}/${maxRetries}):`, error?.response?.data || error?.message);
				
				if (isLastAttempt) {
					throw new Error(`Falha ao baixar mídia UAZAPI após ${maxRetries} tentativas: ${error?.message}`);
				}
			}
		}
	}

	async urlToBase64(url, timeoutMs = 60000) {
		const maxRetries = 5;
		const retryDelay = 2000;
		
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				console.log(`Tentativa ${attempt}/${maxRetries} - Baixando arquivo de mídia da URL: ${url}`);
				const resp = await axios.get(url, { 
					responseType: 'arraybuffer', 
					timeout: timeoutMs 
				});
				
				// Verifica se a resposta tem dados
				if (!resp.data || resp.data.length === 0) {
					throw new Error('Arquivo ainda não disponível (resposta vazia)');
				}
				
				const base64 = Buffer.from(resp.data).toString('base64');
				console.log(`Arquivo convertido para base64 com sucesso (${base64.length} caracteres)`);
				return base64;
			} catch (error) {
				const is404 = error?.response?.status === 404;
				const is503 = error?.response?.status === 503;
				const is502 = error?.response?.status === 502;
				const isTimeout = error?.code === 'ECONNABORTED' || error?.message?.includes('timeout');
				const isEmptyData = error?.message?.includes('não disponível') || error?.message?.includes('vazia');
				const isLastAttempt = attempt === maxRetries;
				
				// Retry em caso de 404, 502, 503, timeout ou dados vazios
				const shouldRetry = (is404 || is503 || is502 || isTimeout || isEmptyData) && !isLastAttempt;
				
				if (shouldRetry) {
					console.log(`Erro na tentativa ${attempt} (${error?.response?.status || error?.message}) - Arquivo ainda não processado. Aguardando ${retryDelay}ms antes da próxima tentativa...`);
					await new Promise(resolve => setTimeout(resolve, retryDelay));
					continue;
				}
				
				console.error(`Erro ao baixar arquivo da URL ${url} (tentativa ${attempt}/${maxRetries}):`, error?.message);
				
				if (isLastAttempt) {
					throw new Error(`Falha ao baixar arquivo da URL após ${maxRetries} tentativas: ${error?.message}`);
				}
			}
		}
	}

	async sendViaZAPI(phone, content, messageType = 'text', attachment = null, replyToMessageId = null) {
		const client = axios.create({
			baseURL: this.baseURL,
			headers: {
				'Client-Token': this.clientToken,
				'Content-Type': 'application/json'
			},
			timeout: 30000
		});

		let payload;
		let endpoint;

		switch (messageType) {
		case 'audio':{
			if(attachment && attachment.url){
				payload = {
					phone: phone,
					audio: attachment.url,
					message: content || ''
				};
			}else if(attachment && attachment.base64){
				payload = {
					phone: phone,
					audio: `data:audio/mpeg;base64,${attachment.base64}`,
					message: content || ''
				};
			}
			if (replyToMessageId) {
				payload.messageId = replyToMessageId;
			}
			endpoint = '/send-audio';
			break;
		}
		case 'image': {
			if(attachment && attachment.url){
				payload = {
					phone: phone,
					image: attachment.url,
					caption: content || ''
				};
			}else if(attachment && attachment.base64){
				payload = {
					phone: phone,
					image: `data:image/png;base64,${attachment.base64}`,
					caption: content || ''
				};
			}
			if (replyToMessageId) {
				payload.messageId = replyToMessageId;
			}
			endpoint = '/send-image';
			break;
		}
		case 'video':{
			if(attachment && attachment.url){
				payload = {
					phone: phone,
					video: attachment.url,
					caption: content || ''
				};
			}else if(attachment && attachment.base64){
				payload = {
					phone: phone,
					video: `data:video/mp4;base64,${attachment.base64}`,
					caption: content || ''
				};
			}
			if (replyToMessageId) {
				payload.messageId = replyToMessageId;
			}
			endpoint = '/send-video';
			break;
		}
		case 'document': {
			if (attachment) {
				const documentData = attachment.url || attachment.base64 || '';
				let extension = 'pdf';
				
				if (attachment.url) {
					extension = new String(attachment.url).substring(attachment.url.lastIndexOf('.')+1);
					payload = {
						phone: phone,
						document: documentData,
						fileName: attachment.title || attachment.fileName || 'Documento',
						message: content || ''
					};
				} else if(attachment.base64){
					extension = attachment.fileName ? attachment.fileName.split('.').pop() : 'pdf';
					payload = {
						phone: phone,
						document: `data:application/${extension};base64,${attachment.base64}`,
						fileName: attachment.fileName || attachment.title || 'Documento',
						message: content || ''
					};
				}
				if (replyToMessageId) {
					payload.messageId = replyToMessageId;
				}
				endpoint = `/send-document/${extension}`;
			}
			break;
		}
		default: // text
			payload = {
				phone: phone,
				message: content
			};
			if (replyToMessageId) {
				payload.messageId = replyToMessageId;
			}
			endpoint = '/send-text';
			break;
		}

		const { data } = await client.post(endpoint, payload);
		return { api: 'zapi', result: data };
	}

	async sendViaUAZAPI(phone, content, messageType = 'text', attachment = null, replyToMessageId = null) {
		const client = axios.create({
			baseURL: this.baseURL,
			headers: {
				'token': this.token,
				'Content-Type': 'application/json'
			},
			timeout: 30000
		});

		let payload;
		let endpoint;

		switch (messageType) {
		case 'audio': {
			if (attachment) {
				const audioData = attachment.url || attachment.base64 || '';
				payload = {
					number: phone,
					type: 'ptt',
					file: audioData
				};
				if (content && content.trim() !== '') {
					payload.text = content;
				}
				if (replyToMessageId) {
					payload.replyid = replyToMessageId;
				}
				endpoint = '/send/media';
			}
			break;
		}
		case 'image': {
			if (attachment) {
				const imageData = attachment.url || attachment.base64 || '';
				payload = {
					number: phone,
					type: 'image',
					file: imageData
				};
				if (content && content.trim() !== '') {
					payload.text = content;
				}
				if (replyToMessageId) {
					payload.replyid = replyToMessageId;
				}
				endpoint = '/send/media';
			}
			break;
		}
		case 'video': {
			if (attachment) {
				const videoData = attachment.url || attachment.base64 || '';
				payload = {
					number: phone,
					type: 'video',
					file: videoData
				};
				if (content && content.trim() !== '') {
					payload.text = content;
				}
				if (replyToMessageId) {
					payload.replyid = replyToMessageId;
				}
				endpoint = '/send/media';
			}
			break;
		}
		case 'document': {
			if (attachment) {
				const documentData = attachment.url || attachment.base64 || '';
				payload = {
					number: phone,
					type: 'document',
					file: documentData,
					docName: attachment.fileName
				};
				if (content && content.trim() !== '') {
					payload.text = content;
				}
				if (replyToMessageId) {
					payload.replyid = replyToMessageId;
				}
				endpoint = '/send/media';
			}
			break;
		}
		default: // text
			payload = {
				number: phone,
				text: content
			};
			if (replyToMessageId) {
				payload.replyid = replyToMessageId;
			}
			endpoint = '/send/text';
			break;
		}

		console.log(`Enviando via UAZAPI (${messageType}) - Payload:`, JSON.stringify(payload, null, 2));

		const { data } = await client.post(endpoint, payload);
		
		console.log('Resposta UAZAPI:', JSON.stringify(data,null,2));
		return { api: 'uazapi', result: data };
	}

	async sendViaWuzapi(phone, content, messageType = 'text', attachment = null, lid = null, jid = null, replyToMessageId = null) {
		const client = axios.create({
			baseURL: this.baseURL,
			headers: {
				'Token': `${this.token}`,
				'Content-Type': 'application/json'
			},
			timeout: 30000
		});

		const recipient = lid || jid || phone;
		if (!recipient) {
			throw new Error('Nenhum destinatário válido fornecido (phone, lid ou jid)');
		}

		let payload;
		let endpoint;

		switch (messageType) {
		case 'audio': {
			if (attachment) {
				let audioBase64;
				if (attachment.base64) {
					audioBase64 = attachment.base64;
				} else if (attachment.url) {
					try {
						audioBase64 = await this.urlToBase64(attachment.url);
					} catch (error) {
						console.error('Erro ao baixar áudio para base64:', error.message);
						throw new Error(`Falha ao processar áudio: ${error.message}`);
					}
				} else {
					throw new Error('Nenhum arquivo de áudio fornecido (base64 ou url)');
				}
				
				payload = {
					Phone: recipient,
					Audio: `data:audio/ogg;base64,${audioBase64}`
				};
				if (replyToMessageId) {
					payload.ContextInfo = { 
						StanzaId : replyToMessageId,
						Participant : recipient
					};
				}
				endpoint = '/chat/send/audio';
			}
			break;
		}
		case 'image': {
			if (attachment) {
				let imageBase64;
				if (attachment.base64) {
					imageBase64 = attachment.base64;
				} else if (attachment.url) {
					try {
						imageBase64 = await this.urlToBase64(attachment.url);
					} catch (error) {
						console.error('Erro ao baixar imagem para base64:', error.message);
						throw new Error(`Falha ao processar imagem: ${error.message}`);
					}
				} else {
					throw new Error('Nenhum arquivo de imagem fornecido (base64 ou url)');
				}
				
				payload = {
					Phone: recipient,
					Image: `data:image/jpeg;base64,${imageBase64}`,
					Caption: content || '',
					Id: attachment.messageId || ''
				};
				if (replyToMessageId) {
					payload.ContextInfo = { 
						StanzaId : replyToMessageId,
						Participant : recipient
					};
				}
				endpoint = '/chat/send/image';
			}
			break;
		}
		case 'video': {
			if (attachment) {
				let videoBase64;
				if (attachment.base64) {
					videoBase64 = attachment.base64;
				} else if (attachment.url) {
					try {
						videoBase64 = await this.urlToBase64(attachment.url);
					} catch (error) {
						console.error('Erro ao baixar vídeo para base64:', error.message);
						throw new Error(`Falha ao processar vídeo: ${error.message}`);
					}
				} else {
					throw new Error('Nenhum arquivo de vídeo fornecido (base64 ou url)');
				}
				
				payload = {
					Phone: recipient,
					Video: `data:video/mp4;base64,${videoBase64}`,
					Caption: content || ''
				};
				if (replyToMessageId) {
					payload.ContextInfo = { 
						StanzaId : replyToMessageId,
						Participant : recipient
					};
				}
				endpoint = '/chat/send/video';
			}
			break;
		}
		case 'document': {
			if (attachment) {
				let documentBase64;
				if (attachment.base64) {
					documentBase64 = attachment.base64;
				} else if (attachment.url) {
					try {
						documentBase64 = await this.urlToBase64(attachment.url);
					} catch (error) {
						console.error('Erro ao baixar documento para base64:', error.message);
						throw new Error(`Falha ao processar documento: ${error.message}`);
					}
				} else {
					throw new Error('Nenhum arquivo de documento fornecido (base64 ou url)');
				}
				
				payload = {
					Phone: recipient,
					Document: `data:application/octet-stream;base64,${documentBase64}`,
					FileName: attachment.fileName || attachment.title || 'Documento'
				};
				if (replyToMessageId) {
					payload.ContextInfo = { 
						StanzaId : replyToMessageId,
						Participant : recipient
					};
				}
				endpoint = '/chat/send/document';
			}
			break;
		}
		default: // text
			payload = {
				Phone: recipient,
				Body: content
			};
			if (replyToMessageId) {
				payload.ContextInfo = { 
					StanzaId : replyToMessageId,
					Participant : recipient
				};
			}
			endpoint = '/chat/send/text';
			break;
		}

		const { data } = await client.post(endpoint, payload);
		return { api: 'wuzapi', result: data };
	}

	async sendMessage(phone, content, messageType = 'text', attachments = null, lid = null, jid = null, replyToMessageId = null) {
		try {
			console.log(`Usando API: ${this.provider} para enviar mensagem (${messageType})`);
			
			if (!attachments || attachments.length === 0) {
				console.log(`Enviando mensagem de texto: "${content}"${replyToMessageId ? ` (reply para: ${replyToMessageId})` : ''}`);
				switch (this.provider) {
				case 'zapi':
					return await this.sendViaZAPI(phone, content, 'text', null, replyToMessageId);
				case 'uazapi':
					return await this.sendViaUAZAPI(phone, content, 'text', null, replyToMessageId);
				case 'wuzapi':
					return await this.sendViaWuzapi(phone, content, 'text', null, lid, jid, replyToMessageId);
				default:
					throw new Error(`API não suportada: ${this.provider}`);
				}
			}
			
			const results = [];
			for (let i = 0; i < attachments.length; i++) {
				const attachment = attachments[i];
				const hasAttachmentContent = (i === 0 && typeof content === 'string' && content.length > 0);
				const attachmentContent = hasAttachmentContent ? content : '';
				
				console.log(`Enviando attachment ${i + 1}/${attachments.length} - Tipo: ${attachment.type}${attachmentContent ? ' (com texto)' : ' (sem texto)'}${replyToMessageId ? ` (reply para: ${replyToMessageId})` : ''}`);
				
				let result;
				switch (this.provider) {
				case 'zapi':
					result = await this.sendViaZAPI(phone, attachmentContent, attachment.type, attachment, replyToMessageId);
					break;
				case 'uazapi':
					result = await this.sendViaUAZAPI(phone, attachmentContent, attachment.type, attachment, replyToMessageId);
					break;
				case 'wuzapi':
					result = await this.sendViaWuzapi(phone, attachmentContent, attachment.type, attachment, lid, jid, replyToMessageId);
					break;
				default:
					throw new Error(`API não suportada: ${this.provider}`);
				}
				
				results.push(result);
				
				if (i < attachments.length - 1) {
					await new Promise(resolve => setTimeout(resolve, 2000));
				}
			}
			
			return {
				api: this.provider,
				results,
				totalSent: results.length,
				message: `Enviadas ${results.length} mídias com sucesso`
			};
			
		} catch (err) {
			console.error('Erro ao enviar mensagem no WhatsApp:', err?.response?.data || err?.message);
			throw err;
		}
	}

	async deleteViaUAZAPI(messageId) {
		const client = axios.create({
			baseURL: this.baseURL,
			headers: {
				'token': this.token,
				'Content-Type': 'application/json'
			},
			timeout: 30000
		});

		try {
			console.log(`Deletando mensagem UAZAPI com messageId: ${messageId}`);
			const payload = {
				id: messageId
			};

			const { data } = await client.post('/message/delete', payload);
			
			console.log('Mensagem deletada via UAZAPI:', JSON.stringify(data, null, 2));
			return { api: 'uazapi', result: data };
		} catch (error) {
			console.error(`Erro ao deletar mensagem UAZAPI com messageId ${messageId}:`, error?.response?.data || error?.message);
			throw new Error(`Falha ao deletar mensagem UAZAPI: ${error?.message}`);
		}
	}

	async deleteViaZAPI(messageId, options = {}) {
		const client = axios.create({
			baseURL: this.baseURL,
			headers: {
				'Client-Token': this.clientToken,
				'Content-Type': 'application/json'
			},
			timeout: 30000
		});

		try {
			const recipient = options?.recipient || '';
			const owner = options?.owner !== false; // padrão true

			if (!recipient) {
				throw new Error('Recipient (phone ou id do grupo) é obrigatório para deletar mensagem via Z-API');
			}

			let phoneParam = recipient;
			if (recipient.endsWith('@g.us')) {
				// Grupo do UAZAPI - mantém o formato completo
				phoneParam = recipient;
			} else if (recipient.endsWith('-group')) {
				// Grupo do Z-API - mantém o formato "*-group" (ex: "120363407124580783-group")
				phoneParam = recipient;
			} else {
				// Contato normal - remove caracteres não numéricos
				const digitsOnly = recipient.replace(/\D/g, '');
				if (!digitsOnly) {
					throw new Error(`Recipient inválido para deleção via Z-API: ${recipient}`);
				}
				phoneParam = digitsOnly;
			}

			console.log(`Deletando mensagem Z-API com messageId: ${messageId}, phone: ${phoneParam}, owner: ${owner}`);

			
			const params = {
				messageId: messageId,
				phone: phoneParam,
				owner
			};

			console.log('Enviando payload de Mensagem deletada via Z-API:', JSON.stringify(params, null, 2));

			const { data } = await client.delete('/messages', { params });
			
			console.log('Mensagem deletada via Z-API:', JSON.stringify(data, null, 2));
			return { api: 'zapi', result: data };
		} catch (error) {
			console.error(`Erro ao deletar mensagem Z-API com messageId ${messageId}:`, error?.response?.data || error?.message);
			throw new Error(`Falha ao deletar mensagem Z-API: ${error?.message}`);
		}
	}

	async deleteViaWuzapi(messageId) {
		const client = axios.create({
			baseURL: this.baseURL,
			headers: {
				'Token': `${this.token}`,
				'Content-Type': 'application/json'
			},
			timeout: 30000
		});

		try {
			console.log(`Deletando mensagem Wuzapi com messageId: ${messageId}`);
			const payload = {
				MessageId: messageId
			};

			const { data } = await client.post('/chat/delete', payload);
			
			console.log('Mensagem deletada via Wuzapi:', JSON.stringify(data, null, 2));
			return { api: 'wuzapi', result: data };
		} catch (error) {
			console.error(`Erro ao deletar mensagem Wuzapi com messageId ${messageId}:`, error?.response?.data || error?.message);
			throw new Error(`Falha ao deletar mensagem Wuzapi: ${error?.message}`);
		}
	}

	async deleteMessage(messageId, options = {}) {
		try {
			console.log(`Usando API: ${this.provider} para deletar mensagem (messageId: ${messageId})`);
			
			switch (this.provider) {
			case 'zapi':
				return await this.deleteViaZAPI(messageId, options);
			case 'uazapi':
				return await this.deleteViaUAZAPI(messageId, options);
			case 'wuzapi':
				return await this.deleteViaWuzapi(messageId, options);
			default:
				throw new Error(`API não suportada: ${this.provider}`);
			}
		} catch (err) {
			console.error('Erro ao deletar mensagem no WhatsApp:', err?.response?.data || err?.message);
			throw err;
		}
	}
}

// Funções de compatibilidade para manter retrocompatibilidade
let defaultService = null;

function getDefaultService() {
	if (!defaultService) {
		const zapiInstance = process.env.ZAPI_INSTANCIA || null;
		const zapiToken = process.env.ZAPI_TOKEN_INSTANCIA || null;
		const zapiClientToken = process.env.ZAPI_CLIENT_TOKEN;
		
		if (zapiInstance && zapiToken && zapiClientToken) {
			defaultService = new WhatsAppService({
				provider: 'zapi',
				instance: zapiInstance,
				token: zapiToken,
				clientToken: zapiClientToken
			});
		} else {
			let uazapiBaseURL = process.env.UAZAPI_BASE_URL;
			if(uazapiBaseURL){
				uazapiBaseURL = uazapiBaseURL.replace(/\/$/, '');
			}
			const uazapiToken = process.env.UAZAPI_TOKEN;
			const uazapiNumber = process.env.UAZAPI_WHATSAPP;
			
			if (uazapiBaseURL && uazapiToken && uazapiNumber) {
				defaultService = new WhatsAppService({
					provider: 'uazapi',
					baseURL: uazapiBaseURL,
					token: uazapiToken,
					whatsappNumber: uazapiNumber
				});
			} else {
				let wuzapiBaseURL = process.env.WUZAPI_BASE_URL;
				if(wuzapiBaseURL){
					wuzapiBaseURL = wuzapiBaseURL.replace(/\/$/, '');
				}
				const wuzapiToken = process.env.WUZAPI_TOKEN;
				
				if (wuzapiBaseURL && wuzapiToken) {
					defaultService = new WhatsAppService({
						provider: 'wuzapi',
						baseURL: wuzapiBaseURL,
						token: wuzapiToken
					});
				} else {
					throw new Error('Nenhuma API do WhatsApp configurada');
				}
			}
		}
	}
	return defaultService;
}

export async function downloadUazapiMedia(messageId, timeoutMs = 60000) {
	const service = getDefaultService();
	if (service.provider !== 'uazapi') {
		throw new Error('downloadUazapiMedia só está disponível para UAZAPI');
	}
	return await service.downloadUazapiMedia(messageId, timeoutMs);
}

export async function sendWhatsAppMessage(phone, content, messageType = 'text', attachments = null, lid = null, jid = null, replyToMessageId = null) {
	const service = getDefaultService();
	return await service.sendMessage(phone, content, messageType, attachments, lid, jid, replyToMessageId);
}

export async function deleteWhatsAppMessage(messageId) {
	const service = getDefaultService();
	return await service.deleteMessage(messageId);
}

export function checkAPIConfiguration() {
	const webhookBaseConfigured = !!(process.env.WEBHOOK_BASE_URL && process.env.WEBHOOK_NAME);

	if(!webhookBaseConfigured){
		console.warn('Configure as Variáveis WEBHOOK_BASE_URL e WEBHOOK_NAME');
		throw new Error('Configure as Variáveis WEBHOOK_BASE_URL e WEBHOOK_NAME');
	}

	const chatwootBaseConfigured = !!(process.env.CHATWOOT_BASE_URL && process.env.CHATWOOT_API_TOKEN && process.env.CHATWOOT_ACCOUNT_ID);

	if(!chatwootBaseConfigured){
		console.warn('Configure as Variáveis CHATWOOT_BASE_URL, CHATWOOT_API_TOKEN e CHATWOOT_ACCOUNT_ID');
		throw new Error('Configure as Variáveis CHATWOOT_BASE_URL, CHATWOOT_API_TOKEN e CHATWOOT_ACCOUNT_ID');
	}

	const zapiConfigured = !!(process.env.ZAPI_INSTANCIA && process.env.ZAPI_TOKEN_INSTANCIA && process.env.ZAPI_CLIENT_TOKEN);
	const uazapiConfigured = !!(process.env.UAZAPI_BASE_URL && process.env.UAZAPI_TOKEN);
	const wuzapiConfigured = !!(process.env.WUZAPI_BASE_URL && process.env.WUZAPI_TOKEN);
	
	console.log('Configuração das APIs WhatsApp:');
	console.log(`- Z-API: ${zapiConfigured ? 'Com DADOS INFORMADOS' : 'Com dados NÃO informados'}`);
	console.log(`- UAZAPI: ${uazapiConfigured ? 'Com DADOS INFORMADOS' : 'Com dados NÃO informados'}`);
	console.log(`- Wuzapi: ${wuzapiConfigured ? 'Com DADOS INFORMADOS' : 'Com dados NÃO informados'}`);

	if(zapiConfigured){
		console.log('Usaremos Z-API para envio de mensagens.');
		console.log('Adicione o endereço de Webhook na sua Instância para o eventos de mensagem ("Ao receber").');
		console.log('Lembre-se de deixar marcado a opção "Notificar as enviadas por mim também".');
		console.log(`Endereço do Webhook: ${process.env.WEBHOOK_BASE_URL}/${process.env.WEBHOOK_NAME}`);
	}else if(!zapiConfigured && uazapiConfigured){
		console.log('Usaremos UAZAPI para envio de mensagens.');
	}else if(!zapiConfigured && !uazapiConfigured && wuzapiConfigured){
		console.log('Usaremos Wuzapi para envio de mensagens.');
		console.log('Adicione o endereço de Webhook na sua Instância para o eventos de APENAS mensagem. (Subscribed Events: Message)');
		console.log(`Endereço do Webhook: ${process.env.WEBHOOK_BASE_URL}/${process.env.WEBHOOK_NAME}`);
	}
	
	if (!zapiConfigured && !uazapiConfigured && !wuzapiConfigured) {
		console.warn('Nenhuma API do WhatsApp configurada!');		
		throw new Error('Nenhuma API do WhatsApp configurada!');
	}
	
	return true;
}
