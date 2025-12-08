'use strict';

import axios from 'axios';
import fs from 'node:fs/promises';
import path from 'node:path';
import FormData from 'form-data';
import { storeMessageIdMapping } from '../utils/messageCache.js';

export class ChatwootService {
	constructor(config) {
		this.baseURL = (config.baseURL || '').replace(/\/$/, '');
		this.webhookBaseURL = (config.webhookBaseURL || '').replace(/\/$/, '');
		this.webhookName = config.webhookName || 'wootrico';
		this.apiToken = config.apiToken;
		this.accountId = String(config.accountId);
		this.inboxName = config.inboxName || 'Wootrico';
		this.dataFilePath = config.dataFilePath || '/app/data/app-data.json';
		this.reabrirConversa = config.reabrirConversa !== false;
		this.inboxId = null;
		this.downloadUazapiMediaFn = config.downloadUazapiMediaFn || null;
		// Throttling para evitar sobrecarga do Chatwoot com múltiplas requisições de mídia
		this.lastMediaSendTime = 0;
		this.mediaSendDelay = parseInt(process.env.CHATWOOT_MEDIA_DELAY_MS || '1000', 10); // Delay padrão de 1 segundo entre envios de mídia
		// Status da conversa ao criar (open, resolved, pending) - padrão: 'open'
		const validStatuses = ['open', 'resolved', 'pending'];
		const statusRaw = config.conversationStatus || 'open';
		this.conversationStatus = validStatuses.includes(statusRaw.toLowerCase()) ? statusRaw.toLowerCase() : 'open';
	}

	setDownloadUazapiMediaFn(fn) {
		if (typeof fn === 'function') {
			this.downloadUazapiMediaFn = fn;
		} else {
			this.downloadUazapiMediaFn = null;
		}
	}

	/**
	 * Garante um delay entre envios de mídia para evitar sobrecarga do Chatwoot
	 * @returns {Promise<void>}
	 */
	async throttleMediaSend() {
		const now = Date.now();
		const timeSinceLastSend = now - this.lastMediaSendTime;
		
		if (timeSinceLastSend < this.mediaSendDelay) {
			const waitTime = this.mediaSendDelay - timeSinceLastSend;
			console.log(`[throttleMediaSend] Aguardando ${waitTime}ms antes de enviar próxima mídia ao Chatwoot`);
			await new Promise(resolve => setTimeout(resolve, waitTime));
		}
		
		this.lastMediaSendTime = Date.now();
	}

	/**
	 * Baixa um arquivo de mídia de uma URL com retry logic
	 * @param {string} url - URL do arquivo
	 * @param {number} timeoutMs - Timeout em milissegundos
	 * @param {number} maxRetries - Número máximo de tentativas
	 * @param {number} retryDelay - Delay entre tentativas em milissegundos
	 * @returns {Promise<Buffer>} - Buffer com os dados do arquivo
	 */
	async downloadMediaWithRetry(url, timeoutMs = 30000, maxRetries = 5, retryDelay = 2000) {
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				console.log(`Tentativa ${attempt}/${maxRetries} - Baixando mídia da URL: ${url}`);
				const response = await axios.get(url, { 
					responseType: 'arraybuffer',
					timeout: timeoutMs
				});
				
				// Verifica se a resposta tem dados
				if (!response.data || response.data.length === 0) {
					throw new Error('Arquivo ainda não disponível (resposta vazia)');
				}
				
				console.log(`Mídia baixada com sucesso (${response.data.length} bytes)`);
				return response.data;
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
				
				console.error(`Erro ao baixar mídia da URL ${url} (tentativa ${attempt}/${maxRetries}):`, error?.message);
				
				if (isLastAttempt) {
					throw new Error(`Falha ao baixar mídia da URL após ${maxRetries} tentativas: ${error?.message}`);
				}
			}
		}
	}

	getClient() {
		if (!this.baseURL || !this.apiToken || !this.accountId) {
			throw new Error('Variáveis do Chatwoot ausentes (BASE_URL, API_TOKEN, ACCOUNT_ID)');
		}
		return axios.create({
			baseURL: this.baseURL,
			headers: { 'api_access_token': this.apiToken },
			timeout: 15000
		});
	}

	async ensureDirectoryFor(filePath) {
		const dir = path.dirname(filePath);
		await fs.mkdir(dir, { recursive: true });
	}

	async readStoredInboxId() {
		try {
			const content = await fs.readFile(this.dataFilePath, 'utf8');
			const json = JSON.parse(content || '{}');
			return json?.inboxId ? String(json.inboxId) : null;
		} catch {
			return null;
		}
	}

	async writeStoredInboxId(inboxId, extra = {}) {
		await this.ensureDirectoryFor(this.dataFilePath);
		const payload = {
			inboxId: String(inboxId),
			inboxName: this.inboxName || extra.inboxName || null,
			savedAt: new Date().toISOString(),
			...extra
		};
		await fs.writeFile(this.dataFilePath, JSON.stringify(payload, null, 2), 'utf8');
	}

	async getInboxById(client, id) {
		const { data } = await client.get(`/api/v1/accounts/${this.accountId}/inboxes/${id}`);
		return data;
	}

	async findInboxByName(client, name) {
		const { data } = await client.get(`/api/v1/accounts/${this.accountId}/inboxes`);
		const list = Array.isArray(data) ? data : (data?.payload || data?.data || []);
		if (!Array.isArray(list)) return null;
		const lower = String(name).toLowerCase();
		return list.find((i) => String(i?.name || '').toLowerCase() === lower) || null;
	}

	async createApiInbox(client, name) {
		const { data } = await client.post(`/api/v1/accounts/${this.accountId}/inboxes`, {
			name,
			channel: { 
				type: 'api',
				webhook_url : `${this.webhookBaseURL}/${this.webhookName}/callback`
			},
			allow_messages_after_resolved: this.reabrirConversa
		});	
		return data;
	}

	async ensureInbox() {
		const client = this.getClient();
		const inboxName = this.inboxName || 'Wootrico';

		// 1) Tenta ler do arquivo
		const storedId = await this.readStoredInboxId();	

		if (storedId) {
			try {
				const inbox = await this.getInboxById(client, storedId);

				if(inbox.name !== inboxName){
					const existing = await this.findInboxByName(client, inboxName);
					if (existing?.id) {
						await this.writeStoredInboxId(existing.id, { inboxName });
						this.inboxId = String(existing.id);
						console.log(`Chatwoot: inbox '${inboxName}' encontrada. id=${existing.id}`);
						return String(existing.id);
					}
				} else {
					const id = inbox?.id || inbox?.data?.id || storedId;
					this.inboxId = String(id);
					console.log(`Chatwoot: usando inbox existente id=${id} (via arquivo de dados)`);
					return String(id);
				}
			} catch (err) {
				console.warn(`Chatwoot: inbox id=${storedId} do arquivo não encontrada. Será recriada.`, err?.response?.status || err?.message);
			}
		}

		// 2) Se nao achou pelo arquivo e Se tiver nome configurado, tenta localizar por nome
		if (inboxName) {
			try {
				const existing = await this.findInboxByName(client, inboxName);
				if (existing?.id) {
					await this.writeStoredInboxId(existing.id, { inboxName });
					this.inboxId = String(existing.id);
					console.log(`Chatwoot: inbox '${inboxName}' encontrada. id=${existing.id}`);
					return String(existing.id);
				}
			} catch (err) {
				console.warn('Chatwoot: falha ao buscar inbox por nome. Prosseguindo para criação.', err?.response?.status || err?.message);
			}
		}

		// 3) Cria uma nova inbox (API channel)
		const nameForCreation = inboxName || 'Wootrico';
		const created = await this.createApiInbox(client, nameForCreation);
		const createdId = created?.id || created?.data?.id;
		if (!createdId) {
			throw new Error('Chatwoot: falha ao criar inbox (id ausente na resposta)');
		}
		await this.writeStoredInboxId(createdId, { inboxName: nameForCreation });
		this.inboxId = String(createdId);
		console.log(`Chatwoot: inbox criada '${nameForCreation}' id=${createdId}`);
		return String(createdId);
	}

	async findContactByPhone(client, phone, lid = null, jid = null) {
		try {
			// Se temos LID ou JID, busca por eles primeiro
			if (lid) {
				console.log(`Procurando contato pelo LID: ${lid}`);
				const { data } = await client.get(`/api/v1/accounts/${this.accountId}/contacts/search?q=${encodeURIComponent(lid)}`);
				const contacts = Array.isArray(data) ? data : (data?.payload || []);
				const contact = contacts.find(c => c?.identifier === lid) || null;
				if (contact) return contact;
			}
			
			if (jid) {
				console.log(`Procurando contato pelo JID: ${jid}`);
				const { data } = await client.get(`/api/v1/accounts/${this.accountId}/contacts/search?q=${encodeURIComponent(jid)}`);
				const contacts = Array.isArray(data) ? data : (data?.payload || []);
				const contact = contacts.find(c => c?.identifier === jid) || null;
				if (contact) return contact;
			}
			
			// Se temos phone, busca por ele
			if (phone) {
				console.log(`Procurando contato pelo phone: ${phone}`);
				const { data } = await client.get(`/api/v1/accounts/${this.accountId}/contacts/search?q=${encodeURIComponent(phone)}`);
				const contacts = Array.isArray(data) ? data : (data?.payload || []);
				// Se phone é um número válido E.164, busca por phone_number
				if (/^\+[1-9]\d{1,14}$/.test(phone)) {
					return contacts.find(c => c?.phone_number === phone) || null;
				} else if (phone.endsWith('@g.us')) {
					// Para grupos (wa_chatid), busca apenas por identifier
					return contacts.find(c => c?.identifier === phone) || null;
				} else {
					// Para outros identificadores, busca por identifier
					return contacts.find(c => c?.identifier === phone) || null;
				}
			}
			
			return null;
		} catch {
			return null;
		}
	}

	async createContact(client, phone, senderPhoto, name = null, lid = null, jid = null) {
		// Determina o identificador principal e o nome
		let identifier, contactName;
		
		if (lid) {
			identifier = lid;
			contactName = name || `Contato ${lid}`;
		} else if (jid) {
			identifier = jid;
			contactName = name || `Contato ${jid}`;
		} else if (phone) {
			identifier = phone;
			contactName = name || `Contato ${phone}`;
		} else {
			throw new Error('Nenhum identificador válido fornecido (phone, lid ou jid)');
		}
		
		console.log(`Criando Contato com nome ${contactName} identificador ${identifier} e avatar ${senderPhoto}`);
		
		const contactData = {
			name: contactName,
			identifier: identifier
		};
		
		// Adiciona phone_number APENAS se for um número válido E.164
		if (phone && /^\+[1-9]\d{1,14}$/.test(phone)) {
			contactData.phone_number = phone;
		}
		
		let data;
		if (senderPhoto) {
			try {
				const avatarPayload = await this.downloadAndPrepareAvatar(senderPhoto);
				if (avatarPayload) {
					const formData = new FormData();
					formData.append('name', contactData.name);
					formData.append('identifier', contactData.identifier);
					if (contactData.phone_number) {
						formData.append('phone_number', contactData.phone_number);
					}
					formData.append('avatar', avatarPayload.buffer, {
						filename: avatarPayload.filename,
						contentType: avatarPayload.contentType
					});
					
					({ data } = await client.post(
						`/api/v1/accounts/${this.accountId}/contacts`,
						formData,
						{ headers: { ...formData.getHeaders() } }
					));
				} else {
					contactData.avatar_url = senderPhoto;
					({ data } = await client.post(`/api/v1/accounts/${this.accountId}/contacts`, contactData));
				}
			} catch (error) {
				console.warn(`Falha ao baixar/enviar avatar do contato (${identifier}). Prosseguindo sem avatar.`, error?.message || error);
				({ data } = await client.post(`/api/v1/accounts/${this.accountId}/contacts`, contactData));
			}
		} else {
			({ data } = await client.post(`/api/v1/accounts/${this.accountId}/contacts`, contactData));
		}

		return data?.payload?.contact;
	}

	async downloadAndPrepareAvatar(url) {
		const maxRetries = 3;
		const retryDelay = 1500;
		
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				console.log(`Tentativa ${attempt}/${maxRetries} - Baixando avatar da URL: ${url}`);
				const response = await axios.get(url, {
					responseType: 'arraybuffer',
					timeout: 15000,
					headers: {
						'User-Agent': 'Mozilla/5.0 (ChatwootAvatarFetcher)',
						'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
					}
				});
				
				// Verifica se a resposta tem dados
				if (!response.data || response.data.length === 0) {
					throw new Error('Avatar ainda não disponível (resposta vazia)');
				}
				
				const contentType = response.headers['content-type'] || 'image/jpeg';
				const fileExtension = contentType.split('/')[1] || 'jpg';
				let filename = `avatar-${Date.now()}.${fileExtension}`;
				try {
					const parsedUrl = new URL(url);
					const lastSegment = parsedUrl.pathname.split('/').filter(Boolean).pop();
					if (lastSegment) {
						filename = lastSegment.includes('.') ? lastSegment : `${lastSegment}.${fileExtension}`;
					}
				} catch {
					// Ignora erros de URL e mantém filename padrão
				}
				
				console.log(`Avatar baixado com sucesso (${response.data.length} bytes)`);
				return {
					buffer: Buffer.from(response.data),
					contentType,
					filename
				};
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
					console.log(`Erro na tentativa ${attempt} (${error?.response?.status || error?.message}) - Avatar ainda não processado. Aguardando ${retryDelay}ms antes da próxima tentativa...`);
					await new Promise(resolve => setTimeout(resolve, retryDelay));
					continue;
				}
				
				console.warn(`Erro ao baixar avatar da URL ${url} (tentativa ${attempt}/${maxRetries}):`, error?.message);
				
				if (isLastAttempt) {
					console.warn('Não foi possível baixar avatar externo após todas as tentativas:', error?.message || error);
					return null;
				}
			}
		}
		return null;
	}

	async findOrCreateContact(client, phone, senderPhoto, name = null, lid = null, jid = null) {
		let contact = await this.findContactByPhone(client, phone, lid, jid);
		if (!contact) {
			contact = await this.createContact(client, phone, senderPhoto, name, lid, jid);		
		} else {
			const identifier = lid || jid || phone;
			console.log(`Chatwoot: contato encontrado ${identifier} (id=${contact?.id})`);
		}
		return contact;
	}

	async findConversationByContact(client, contactId, inboxId) {
		try {
			let page = 1;		
			
			console.log(`Busca de conversa - Contact: ${contactId}, Inbox: ${inboxId}, ReabrirConversa: ${this.reabrirConversa}`);
			
			if (this.reabrirConversa) {
				console.log('Buscando conversas fechadas (resolved) primeiro...');
				const resolvedConversation = await this.findResolvedConversationByContact(client, contactId, inboxId);
				if (resolvedConversation) {
					console.log(`Conversa fechada encontrada: ${resolvedConversation.id}, reabrindo...`);
					await this.reopenConversation(client, resolvedConversation.id);
					return resolvedConversation;
				}
			}
			
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const params = {
					status: 'open',
					inbox_id: inboxId,
					page: page,
					sort_order: 'latest_first'
				};
				
				const { data } = await client.get(`/api/v1/accounts/${this.accountId}/conversations`, { params });
				
				const conversations = data?.data?.payload || [];
				
				if (conversations.length === 0) {
					console.log(`Página ${page} vazia, fim da busca`);
					break;
				}
				
				const conversation = conversations.find(conv => {
					const conversationContactId = conv?.meta?.sender?.id;
					return conversationContactId === contactId;
				});
				
				if (conversation) {
					console.log(`Conversa aberta encontrada na página ${page}: ${conversation.id}`);
					return conversation;
				}
				
				console.log(`Conversa não encontrada na página ${page}, continuando busca...`);
				page++;
				
				if (page > 50) {
					console.warn('Limite de páginas atingido (50), parando busca');
					break;
				}
			}
			
			console.log('Nenhuma conversa encontrada após percorrer todas as páginas');
			return null;
		} catch (err) {
			console.error('Erro ao buscar conversa:', err?.response?.data || err?.message);
			return null;
		}
	}

	async findResolvedConversationByContact(client, contactId, inboxId) {
		try {
			let page = 1;
			
			console.log(`Buscando conversas fechadas - Contact: ${contactId}, Inbox: ${inboxId}`);
			
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const params = {
					status: 'resolved',
					inbox_id: inboxId,
					page: page,
					sort_order: 'latest_first'
				};
				
				const { data } = await client.get(`/api/v1/accounts/${this.accountId}/conversations`, { params });
				const conversations = data?.data?.payload || [];
				
				if (conversations.length === 0) {
					console.log(`Página ${page} de conversas fechadas vazia, fim da busca`);
					break;
				}
				
				const conversation = conversations.find(conv => {
					const conversationContactId = conv?.meta?.sender?.id;
					return conversationContactId === contactId;
				});
				
				if (conversation) {
					console.log(`Conversa fechada encontrada na página ${page}: ${conversation.id}`);
					return conversation;
				}
				
				page++;
				
				if (page > 50) {
					console.warn('Limite de páginas atingido (50) para conversas fechadas, parando busca');
					break;
				}
			}
			
			console.log('Nenhuma conversa fechada encontrada');
			return null;
		} catch (err) {
			console.error('Erro ao buscar conversas fechadas:', err?.response?.data || err?.message);
			return null;
		}
	}

	async reopenConversation(client, conversationId) {
		try {
			console.log(`Reabrindo conversa: ${conversationId}`);
			const { data } = await client.post(`/api/v1/accounts/${this.accountId}/conversations/${conversationId}/toggle_status`, {
				status: 'open'
			});
			console.log(`Conversa ${conversationId} reaberta com sucesso`);
			return data;
		} catch (err) {
			console.error(`Erro ao reabrir conversa ${conversationId}:`, err?.response?.data || err?.message);
			throw err;
		}
	}

	async createConversation(client, contactId, inboxId) {
		const { data } = await client.post(`/api/v1/accounts/${this.accountId}/conversations`, {
			contact_id: contactId,
			inbox_id: inboxId,
			status: this.conversationStatus
		});
		return data;
	}

	async findOrCreateConversation(client, contactId, inboxId) {
		let conversation = await this.findConversationByContact(client, contactId, inboxId);
		if (!conversation) {
			conversation = await this.createConversation(client, contactId, inboxId);
			console.log(`Chatwoot: conversa criada para contato ${contactId} (id=${conversation?.id})`);
		} else {
			console.log(`Chatwoot: conversa encontrada para contato ${contactId} (id=${conversation?.id})`);
		}
		return conversation;
	}

	async sendMessage(client, conversationId, content, messageType = 'incoming', replyId) {
		if(!replyId){
			const { data } = await client.post(`/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`, {
				content: String(content),
				message_type: messageType
			});
			return data;
		} else {
			const { data } = await client.post(`/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`, {
				content: String(content),
				message_type: messageType,
				content_attributes : {
					in_reply_to : replyId,
					in_reply_to_external_id : null
				}
			});
			return data;
		}
	}

	async sendMessageWithImage(client, conversationId, content, image, messageType = 'incoming', origin = null, messageId = null, replyId =null) {
		// Nota: Throttling é aplicado no processOutgoingMessage/processIncomingMessage para evitar duplicação
		
		const maxRetries = 3;
		const retryDelay = 2000;
		
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				let imageBuffer;
				let filename;
				
				console.log(`[sendMessageWithImage] Tentativa ${attempt}/${maxRetries} - ConversationId: ${conversationId}, MessageType: ${messageType}, Origin: ${origin}, MessageId: ${messageId}, ReplyId: ${replyId || 'null'}`);
				
				if (image.imageUrl && image.imageUrl.trim() !== '') {
					if (origin === 'uazapi' && messageId && this.downloadUazapiMediaFn) {
						try {
							console.log(`[sendMessageWithImage] Baixando mídia UAZAPI para messageId: ${messageId}`);
							const base64 = await this.downloadUazapiMediaFn(messageId);
							imageBuffer = Buffer.from(base64, 'base64');
							filename = `image.${image.mimeType?.split('/')[1] || 'jpg'}`;
							console.log(`[sendMessageWithImage] Mídia UAZAPI convertida para buffer - Tamanho: ${imageBuffer.length} bytes, Filename: ${filename}`);
						} catch (error) {
							console.warn(`[sendMessageWithImage] Falha ao baixar via UAZAPI, tentando URL direta com retry: ${error.message}`);
							imageBuffer = await this.downloadMediaWithRetry(image.imageUrl, 30000, 5, 2000);
							filename = `image.${image.mimeType?.split('/')[1] || 'jpg'}`;
						}
					} else {
						imageBuffer = await this.downloadMediaWithRetry(image.imageUrl, 30000, 5, 2000);
						filename = `image.${image.mimeType?.split('/')[1] || 'jpg'}`;
					}
				} else if (image.base64 && image.base64.trim() !== '') {
					imageBuffer = Buffer.from(image.base64, 'base64');
					filename = `image.${image.mimeType?.split('/')[1] || 'jpg'}`;
					console.log(`[sendMessageWithImage] Usando base64 fornecido - Tamanho: ${imageBuffer.length} bytes`);
				} else {
					console.warn('[sendMessageWithImage] Nenhuma URL ou base64 de imagem fornecida, enviando apenas texto');
					return await this.sendMessage(client, conversationId, content || image.caption || 'Imagem recebida sem URL ou Base 64', messageType);
				}
				
				const formData = new FormData();
				formData.append('content', String(content || image.caption || ''));
				formData.append('message_type', messageType);		
				formData.append('attachments[]', imageBuffer, {
					filename: filename,
					contentType: image.mimeType || 'image/jpeg'
				});

				console.log(`[sendMessageWithImage] Enviando imagem para Chatwoot - ConversationId: ${conversationId}, Tamanho: ${imageBuffer.length} bytes, MimeType: ${image.mimeType || 'image/jpeg'}`);

				// Timeout maior para uploads de mídia (60 segundos)
				const uploadTimeout = 60000;
				
				let data;
				if(!replyId){
					const response = await client.post(
						`/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`,
						formData,
						{
							headers: {
								...formData.getHeaders(),
								'api_access_token': this.apiToken
							},
							timeout: uploadTimeout
						}
					);
					data = response.data;
				} else{
					const response = await client.post(
						`/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`,
						formData,
						{
							headers: {
								...formData.getHeaders(),
								'api_access_token': this.apiToken
							},
							timeout: uploadTimeout
						}
					);
					data = response.data;
				}
				
				// Verifica se recebeu resposta válida
				if (data) {
					// Chatwoot pode retornar id diretamente ou dentro de payload
					const chatwootMessageId = data.id || data.payload?.id || data.payload?.message?.id;
					if (chatwootMessageId) {
						console.log(`[sendMessageWithImage] Resposta do Chatwoot recebida - MessageId: ${chatwootMessageId}, Status: sucesso`);
						return data;
					} else {
						console.warn('[sendMessageWithImage] Resposta do Chatwoot recebida mas sem ID de mensagem:', JSON.stringify(data, null, 2));
						throw new Error('Resposta do Chatwoot sem ID de mensagem');
					}
				} else {
					throw new Error('Resposta do Chatwoot vazia ou null');
				}
			} catch (error) {
				const isTimeout = error?.code === 'ECONNABORTED' || error?.message?.includes('timeout');
				const isNetworkError = error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT' || error?.code === 'ENOTFOUND';
				const is5xx = error?.response?.status >= 500 && error?.response?.status < 600;
				const is429 = error?.response?.status === 429; // Rate limit
				const isLastAttempt = attempt === maxRetries;
				
				// Retry em caso de timeout, erro de rede, 5xx ou rate limit
				const shouldRetry = (isTimeout || isNetworkError || is5xx || is429) && !isLastAttempt;
				
				if (shouldRetry) {
					// Delay progressivo: 2s, 4s, 6s...
					const currentRetryDelay = retryDelay * attempt;
					console.warn(`[sendMessageWithImage] Erro na tentativa ${attempt}/${maxRetries} - ${error?.response?.status || error?.code || error?.message}. Aguardando ${currentRetryDelay}ms antes de retry...`);
					await new Promise(resolve => setTimeout(resolve, currentRetryDelay));
					continue;
				}
				
				// Se não deve fazer retry ou é última tentativa, loga erro e tenta fallback
				console.error(`[sendMessageWithImage] Erro ao enviar imagem para Chatwoot (tentativa ${attempt}/${maxRetries}) - ConversationId: ${conversationId}, Origin: ${origin}, MessageId: ${messageId}`);
				console.error('[sendMessageWithImage] Detalhes do erro:', {
					message: error?.message,
					code: error?.code,
					status: error?.response?.status,
					statusText: error?.response?.statusText,
					data: error?.response?.data,
					stack: process.env.LOG_LEVEL === 'debug' ? error?.stack : undefined
				});
				
				// Na última tentativa, tenta fallback
				if (isLastAttempt) {
					console.log('[sendMessageWithImage] Última tentativa falhou, tentando enviar mensagem de texto como fallback');
					try {
						const fallbackMessage = await this.sendMessage(client, conversationId, content || image.caption || 'Imagem recebida', messageType);
						console.log(`[sendMessageWithImage] Fallback enviado - MessageId: ${fallbackMessage?.id || 'null'}`);
						return fallbackMessage;
					} catch (fallbackError) {
						console.error('[sendMessageWithImage] Fallback também falhou:', fallbackError?.message);
						throw error; // Lança o erro original
					}
				}
			}
		}
	}

	async sendMessageWithAudio(client, conversationId, content, audio, messageType = 'incoming', origin = null, messageId = null, replyId=null) {
		try {
			let audioBuffer;
			let filename;
			
			if (audio.audioUrl && audio.audioUrl.trim() !== '') {
				if (origin === 'uazapi' && messageId && this.downloadUazapiMediaFn) {
					try {
						const base64 = await this.downloadUazapiMediaFn(messageId);
						audioBuffer = Buffer.from(base64, 'base64');
						filename = `audio.${audio.mimeType?.split('/')[1]?.split(';')[0] || 'ogg'}`;
					} catch (error) {
						console.warn('Falha ao baixar via UAZAPI, tentando URL direta com retry:', error.message);
						audioBuffer = await this.downloadMediaWithRetry(audio.audioUrl, 30000, 5, 2000);
						filename = `audio.${audio.mimeType?.split('/')[1]?.split(';')[0] || 'ogg'}`;
					}
				} else {
					audioBuffer = await this.downloadMediaWithRetry(audio.audioUrl, 30000, 5, 2000);
					filename = `audio.${audio.mimeType?.split('/')[1]?.split(';')[0] || 'ogg'}`;
				}
			} else if (audio.base64 && audio.base64.trim() !== '') {
				audioBuffer = Buffer.from(audio.base64, 'base64');
				filename = `audio.${audio.mimeType?.split('/')[1]?.split(';')[0] || 'ogg'}`;
			} else {
				console.warn('Nenhuma URL ou base64 de áudio fornecida, enviando apenas texto');
				return await this.sendMessage(client, conversationId, content || `Áudio de ${audio.seconds}s recebido sem URL ou Base 64`, messageType);
			}

			const formData = new FormData();
			formData.append('content', String(content || `Áudio de ${audio.seconds}s`));
			formData.append('message_type', messageType);
			formData.append('attachments[]', audioBuffer, {
				filename: filename,
				contentType: audio.mimeType || 'audio/ogg'
			});

			// Timeout maior para uploads de mídia (60 segundos)
			const uploadTimeout = 60000;

			if(!replyId){
				const { data } = await client.post(
					`/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`,
					formData,
					{
						headers: {
							...formData.getHeaders(),
							'api_access_token': this.apiToken
						},
						timeout: uploadTimeout
					}
				);
				return data;
			} else{
				const { data } = await client.post(
					`/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`,
					formData,
					{
						headers: {
							...formData.getHeaders(),
							'api_access_token': this.apiToken
						},					 
						content_attributes : {
							in_reply_to : replyId,
							in_reply_to_external_id : null
						},
						timeout: uploadTimeout
					}
				);
				return data;			
			}
		} catch (error) {
			console.error('Erro ao enviar áudio:', error?.response?.data || error?.message);
			return await this.sendMessage(client, conversationId, content || `Áudio de ${audio.seconds}s recebido`, messageType);
		}
	}

	async sendMessageWithDocument(client, conversationId, content, document, messageType = 'incoming', origin = null, messageId = null, replyId=null) {
		try {
			let documentBuffer;
			let filename;
			
			if (document.documentUrl && document.documentUrl.trim() !== '') {
				if (origin === 'uazapi' && messageId && this.downloadUazapiMediaFn) {
					try {
						const base64 = await this.downloadUazapiMediaFn(messageId);
						documentBuffer = Buffer.from(base64, 'base64');
						filename = document.fileName || 'documento';
					} catch (error) {
						console.warn('Falha ao baixar via UAZAPI, tentando URL direta com retry:', error.message);
						documentBuffer = await this.downloadMediaWithRetry(document.documentUrl, 30000, 5, 2000);
						filename = document.fileName || 'documento';
					}
				} else {
					documentBuffer = await this.downloadMediaWithRetry(document.documentUrl, 30000, 5, 2000);
					filename = document.fileName || 'documento';
				}
			} else if (document.base64 && document.base64.trim() !== '') {
				documentBuffer = Buffer.from(document.base64, 'base64');
				filename = document.fileName || 'documento';
			} else {
				console.warn('Nenhuma URL ou base64 de documento fornecida, enviando apenas texto');
				return await this.sendMessage(client, conversationId, content || `Documento de ${document.fileName} recebido sem URL ou Base 64`, messageType);
			}

			const formData = new FormData();
			formData.append('content', String(content || `Documento de ${document.fileName}`));
			formData.append('message_type', messageType);
			formData.append('attachments[]', documentBuffer, {
				filename: filename,
				contentType: document.mimeType || 'application/octet-stream'
			});

			// Timeout maior para uploads de mídia (60 segundos)
			const uploadTimeout = 60000;

			if(!replyId){
				const { data } = await client.post(
					`/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`,
					formData,
					{
						headers: {
							...formData.getHeaders(),
							'api_access_token': this.apiToken
						},
						timeout: uploadTimeout
					}
				);
				return data;
			} else{
				const { data } = await client.post(
					`/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`,
					formData,
					{
						headers: {
							...formData.getHeaders(),
							'api_access_token': this.apiToken
						},					 
						content_attributes : {
							in_reply_to : replyId,
							in_reply_to_external_id : null
						},
						timeout: uploadTimeout
					}
				);
				return data;
			}
		} catch (error) {
			console.error('Erro ao enviar documento:', error?.response?.data || error?.message);
			return await this.sendMessage(client, conversationId, content || `Documento de ${document.fileName} recebido`, messageType);
		}
	}

	async sendMessageWithVideo(client, conversationId, content, video, messageType = 'incoming', origin = null, messageId = null, replyId=null) {
		try {
			let videoBuffer;
			
			if (video.videoUrl && video.videoUrl.trim() !== '') {
				if (origin === 'uazapi' && messageId && this.downloadUazapiMediaFn) {
					try {
						const base64 = await this.downloadUazapiMediaFn(messageId);
						videoBuffer = Buffer.from(base64, 'base64');
					} catch (error) {
						console.warn('Falha ao baixar via UAZAPI, tentando URL direta com retry:', error.message);
						videoBuffer = await this.downloadMediaWithRetry(video.videoUrl, 60000, 5, 2000);
					}
				} else {
					videoBuffer = await this.downloadMediaWithRetry(video.videoUrl, 60000, 5, 2000);
				}
			} else if (video.base64 && video.base64.trim() !== '') {
				videoBuffer = Buffer.from(video.base64, 'base64');
			} else {
				console.warn('Nenhuma URL ou base64 de vídeo fornecida, enviando apenas texto');
				return await this.sendMessage(client, conversationId, content || `Vídeo de ${video.seconds}s recebido sem URL ou Base 64`, messageType);
			}

			const extension = video.mimeType?.includes('mp4') ? 'mp4' : 
				video.mimeType?.includes('avi') ? 'avi' : 
					video.mimeType?.includes('mov') ? 'mov' : 'mp4';
			
			const filename = `video_${Date.now()}.${extension}`;

			const formData = new FormData();
			formData.append('content', String(content || `Vídeo de ${video.seconds}s recebido`));		
			formData.append('message_type', messageType);				
			formData.append('attachments[]', videoBuffer, {
				filename,
				contentType: video.mimeType || 'video/mp4'
			});

			// Timeout maior para uploads de mídia (60 segundos)
			const uploadTimeout = 60000;

			if(!replyId){
				const { data } = await client.post(
					`/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`,
					formData,
					{
						headers: {
							...formData.getHeaders(),
							'api_access_token': this.apiToken
						},
						timeout: uploadTimeout
					}
				);
				return data;
			} else{
				const { data } = await client.post(
					`/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages`,
					formData,
					{
						headers: {
							...formData.getHeaders(),
							'api_access_token': this.apiToken
						}, 
						content_attributes : {
							in_reply_to : replyId,
							in_reply_to_external_id : null
						},
						timeout: uploadTimeout
					}
				);
				return data;
			}
		} catch (error) {
			console.error('Erro ao enviar vídeo:', error?.response?.data || error?.message);
			return await this.sendMessage(client, conversationId, content || `Vídeo de ${video.seconds}s recebido`, messageType);
		}
	}

	async processIncomingMessage(phone, content, senderPhoto, contactName = null, image = null, audio = null, document = null, video = null, lid = null, jid = null, origin = null, messageId = null, replyId = null, isGroup = false, groupName = null, senderName = null) {
		const client = this.getClient();
		
		if (!this.inboxId) {
			throw new Error('Inbox ID não configurado. Execute ensureInbox primeiro.');
		}

		let contact;
		if (isGroup && groupName) {
			contact = await this.findOrCreateContact(client, phone, senderPhoto, groupName, null, null);
		} else {
			contact = await this.findOrCreateContact(client, phone, senderPhoto, contactName, lid, jid);
		}
		
		const conversation = await this.findOrCreateConversation(client, contact.id, this.inboxId);
		
		// Aplica throttle apenas para mensagens com mídia
		const hasMedia = !!(image || audio || document || video);
		if (hasMedia) {
			await this.throttleMediaSend();
		}
		
		let formattedContent = content;
		let formattedImage = image;
		const formattedAudio = audio;
		let formattedDocument = document;
		let formattedVideo = video;
		
		if (isGroup && senderName) {
			if (image) {
				formattedImage = { ...image };
				if (image.caption) {
					formattedImage.caption = `**${senderName}:**\n${image.caption}`;
				}
				if (content) {
					formattedContent = `**${senderName}:**\n${content}`;
				} else {
					formattedContent = `**${senderName}:**`;
				}
			}
			else if (audio) {
				if (content) {
					formattedContent = `**${senderName}:**\n${content}`;
				} else {
					formattedContent = `**${senderName}:**\nÁudio recebido`;
				}
			}
			else if (document) {
				formattedDocument = { ...document };
				if (document.caption) {
					formattedDocument.caption = `**${senderName}:**\n${document.caption}`;
				}
				if (content) {
					formattedContent = `**${senderName}:**\n${content}`;
				} else {
					formattedContent = `**${senderName}:**`;
				}
			}
			else if (video) {
				formattedVideo = { ...video };
				if (video.caption) {
					formattedVideo.caption = `**${senderName}:**\n${video.caption}`;
				}
				if (content) {
					formattedContent = `**${senderName}:**\n${content}`;
				} else {
					formattedContent = `**${senderName}:**`;
				}
			}
			else if (content) {
				formattedContent = `**${senderName}:**\n${content}`;
			} else {
				formattedContent = `**${senderName}:**`;
			}
		}
		
		let message;
		if (formattedVideo) {
			message = await this.sendMessageWithVideo(client, conversation.id, formattedContent, formattedVideo, 'incoming', origin, messageId, replyId);
		} else if (formattedDocument) {
			message = await this.sendMessageWithDocument(client, conversation.id, formattedContent, formattedDocument, 'incoming', origin, messageId, replyId);
		} else if (formattedAudio) {
			message = await this.sendMessageWithAudio(client, conversation.id, formattedContent, formattedAudio, 'incoming', origin, messageId, replyId);
		} else if (formattedImage) {
			message = await this.sendMessageWithImage(client, conversation.id, formattedContent, formattedImage, 'incoming', origin, messageId, replyId);
		} else {
			message = await this.sendMessage(client, conversation.id, formattedContent, 'incoming', replyId);
		}
		
		if (message?.id) {
			console.log(`Chatwoot: Mensagem criada com ID ${message.id}`);
			if (messageId) {
				storeMessageIdMapping(message.id, messageId, conversation.id, this.inboxId, origin, this.accountId);
			}
		}
		
		return {
			contactId: contact.id,
			conversationId: conversation.id,
			messageId: message?.id,
			message,
			hasImage: !!image,
			hasAudio: !!audio,
			hasDocument: !!document,
			hasVideo: !!video
		};
	}

	async processOutgoingMessage(phone, content, senderPhoto, contactName = null, image = null, audio = null, document = null, video = null, lid = null, jid = null, origin = null, messageId = null, isGroup = false, groupName = null) {
		const client = this.getClient();
		
		if (!this.inboxId) {
			throw new Error('Inbox ID não configurado. Execute ensureInbox primeiro.');
		}

		let contact;
		if (isGroup && groupName) {
			contact = await this.findOrCreateContact(client, phone, senderPhoto, groupName, null, null);
		} else {
			contact = await this.findOrCreateContact(client, phone, senderPhoto, contactName, lid, jid);
		}
		
		const conversation = await this.findOrCreateConversation(client, contact.id, this.inboxId);
		
		console.log(`[processOutgoingMessage] Processando mensagem outgoing - Phone: ${phone}, ConversationId: ${conversation.id}, HasImage: ${!!image}, HasAudio: ${!!audio}, HasDocument: ${!!document}, HasVideo: ${!!video}, Origin: ${origin}, MessageId: ${messageId}`);
		
		// Aplica throttle apenas para mensagens com mídia
		const hasMedia = !!(image || audio || document || video);
		if (hasMedia) {
			await this.throttleMediaSend();
		}
		
		let message;
		if (video) {
			message = await this.sendMessageWithVideo(client, conversation.id, content, video, 'outgoing', origin, messageId);
		} else if (document) {
			message = await this.sendMessageWithDocument(client, conversation.id, content, document, 'outgoing', origin, messageId);
		} else if (audio) {
			message = await this.sendMessageWithAudio(client, conversation.id, content, audio, 'outgoing', origin, messageId);
		} else if (image) {
			message = await this.sendMessageWithImage(client, conversation.id, content, image, 'outgoing', origin, messageId);
		} else {
			message = await this.sendMessage(client, conversation.id, content, 'outgoing');
		}
		
		if (message?.id) {
			console.log(`Chatwoot: Mensagem de agente criada com ID ${message.id}`);
			if (messageId) {
				storeMessageIdMapping(message.id, messageId, conversation.id, this.inboxId, origin, this.accountId);
			}
		} else {
			console.warn(`[processOutgoingMessage] ATENÇÃO: Mensagem não retornou ID do Chatwoot - Message: ${message ? 'objeto existe mas sem ID' : 'null/undefined'}, MessageId: ${messageId}, Origin: ${origin}`);
			if (message) {
				console.warn('[processOutgoingMessage] Resposta do Chatwoot:', JSON.stringify(message, null, 2));
			}
		}
		
		console.log('Mensagem de Outgoing recebido como resposta do Chatwoot com payload: ', JSON.stringify(message,null,2));

		return {
			contactId: contact.id,
			conversationId: conversation.id,
			messageId: message?.id,
			message,
			hasImage: !!image,
			hasAudio: !!audio,
			hasDocument: !!document,
			hasVideo: !!video
		};
	}

	async deleteChatwootMessage(conversationId, messageId) {
		const client = this.getClient();

		if (!conversationId || !messageId) {
			throw new Error('conversationId e messageId são obrigatórios para excluir mensagem no Chatwoot');
		}

		try {
			console.log(`Deletando mensagem no Chatwoot - Conversation: ${conversationId}, Message: ${messageId}`);
			const url = `/api/v1/accounts/${this.accountId}/conversations/${conversationId}/messages/${messageId}`;
			const { data } = await client.delete(url);
			return data;
		} catch (error) {
			console.error(`Erro ao deletar mensagem no Chatwoot (conversation=${conversationId}, message=${messageId}):`, error?.response?.data || error?.message);
			throw error;
		}
	}
}

// Funções de compatibilidade para manter retrocompatibilidade
// Estas funções serão removidas em versões futuras
let defaultService = null;

export function ensureInboxBootstrap() {
	if (!defaultService) {
		const baseURL = (process.env.CHATWOOT_BASE_URL || '').replace(/\/$/, '');
		const webhookBaseURL = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '');
		const webhookName = process.env.WEBHOOK_NAME || 'wootrico';
		const apiToken = process.env.CHATWOOT_API_TOKEN;
		const accountId = process.env.CHATWOOT_ACCOUNT_ID;
		const inboxName = process.env.CHATWOOT_INBOX_NAME || 'Wootrico';
		const dataFilePath = process.env.APP_DATA_FILE || '/app/data/app-data.json';
		const reabrirConversa = process.env.REABRIR_CONVERSA === 'true' || true;
		
		defaultService = new ChatwootService({
			baseURL,
			webhookBaseURL,
			webhookName,
			apiToken,
			accountId,
			inboxName,
			dataFilePath,
			reabrirConversa
		});
	}
	return defaultService.ensureInbox();
}

export function processIncomingMessage(...args) {
	if (!defaultService) {
		ensureInboxBootstrap();
	}
	return defaultService.processIncomingMessage(...args);
}

export function processOutgoingMessage(...args) {
	if (!defaultService) {
		ensureInboxBootstrap();
	}
	return defaultService.processOutgoingMessage(...args);
}

export function deleteChatwootMessage(...args) {
	if (!defaultService) {
		ensureInboxBootstrap();
	}
	return defaultService.deleteChatwootMessage(...args);
}
