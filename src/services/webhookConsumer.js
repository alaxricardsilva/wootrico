'use strict';

import { connect, StringCodec, consumerOpts } from 'nats';
import { normalizeToE164, detectCountryCode } from '../utils/phone.js';
import { getMessageType, addOutgoingTicket, consumeOutgoingTicket, addOutgoingTicketChatwoot, consumeOutgoingTicketChatwoot, getApiMessageId, getChatwootMessageId, removeMessageIdMapping, getChatwootMessageMappingByApiId, getMessageMappingByChatwootId } from '../utils/messageCache.js';
function extractMessageIdFromPayload(payload) {
	if (!payload) return null;

	const directCandidate = payload.messageid 
		|| payload.messageId 
		|| payload.messageID
		|| payload.MessageID
		|| payload.id 
		|| payload.Id 
		|| payload.ID 
		|| payload.uuid 
		|| payload.UUID 
		|| payload?.data?.Id 
		|| payload?.data?.id;

	if (directCandidate) {
		return directCandidate;
	}

	// Procura recursivamente em objetos ou arrays
	for (const value of Object.values(payload)) {
		if (Array.isArray(value)) {
			for (const entry of value) {
				const nested = extractMessageIdFromPayload(entry);
				if (nested) {
					return nested;
				}
			}
		} else if (value && typeof value === 'object') {
			const nested = extractMessageIdFromPayload(value);
			if (nested) {
				return nested;
			}
		}
	}

	return null;
}

function extractApiMessageIds(sendResult) {
	const ids = [];
	const addId = (value) => {
		if (value && !ids.includes(value)) {
			ids.push(value);
		}
	};

	const inspectValue = (value) => {
		if (!value) return;
		if (Array.isArray(value)) {
			value.forEach(item => inspectValue(item));
			return;
		}
		if (typeof value === 'object') {
			const directId = extractMessageIdFromPayload(value);
			if (directId) {
				addId(directId);
			}
			return;
		}
	};

	inspectValue(sendResult?.result || sendResult);
	inspectValue(sendResult?.results);

	return ids;
}

function isZapiNotificationEvent(body) {
	return body?.notification && detectPayloadOrigin(body) === 'zapi';
}

function isZapiRevokeEvent(body) {
	return isZapiNotificationEvent(body) && body.notification === 'REVOKE';
}

import { storeMessageIdMapping } from '../utils/messageCache.js';
import { findIntegrationByWhatsAppIdentifier, findIntegrationByInboxId } from './integrationManager.js';

let nc = null;
let js = null;
const sc = StringCodec();

/**
 * Conecta ao NATS e inicializa JetStream
 */
async function getNatsConnection() {
	if (!nc) {
		try {
			const servers = process.env.NATS_URL || 'nats://nats:4222';
			console.log('[NATS CONSUMER] Conectando a:', servers);
			
			nc = await connect({ 
				servers,
				timeout: 10000,
				reconnect: true,
				maxReconnectAttempts: 5
			});
			
			js = nc.jetstream();
			
			console.log('[NATS CONSUMER] Conectado com sucesso a', servers);
			
		} catch (error) {
			console.error('[NATS CONSUMER] Erro ao conectar:', error);
			throw error;
		}
	}
	return { nc, js, sc };
}

/**
 * Detecta a origem do payload baseado na estrutura
 */
function detectPayloadOrigin(body) {
	// Z-API tem campos específicos como 'phone', 'text.message', 'senderName', 'image', 'audio', 'document', 'video'
	if (body?.phone && body?.momment) {
		return 'zapi';
	}
	// UAZAPI tem estrutura diferente com 'message.content', 'message.sender'
	if (body?.message?.content && body?.message?.sender) {
		return 'uazapi';
	}
	// Wuzapi tem estrutura com 'event.Info', 'event.Message', 'type'
	if (body?.event?.Info && body?.event?.Message && body?.type === 'Message') {
		return 'wuzapi';
	}	
	return 'unknown';
}

function isUazapiMessagesUpdateEvent(body) {
	return body?.EventType === 'messages_update' || body?.type === 'DeletedMessage' || body?.type === 'ReadReceipt';
}

function isUazapiDeletedEvent(body) {
	return (body?.type === 'DeletedMessage' || body?.Type === 'DeletedMessage') &&
		(body?.event?.Type === 'Deleted' || body?.state === 'Deleted');
}

/**
 * Extrai dados do payload Z-API
 */
function extractZapiData(body, desconsiderarGrupo = true, defaultCountry = 'BR') {
	const fromMe = body?.fromMe || false;
	const fromApi = body?.fromApi || false;
	let rawPhone = body?.phone;
	const text = body?.text?.message || '';
	const isGroup = body?.isGroup || null;
	// Para grupos do Z-API, não salva o avatar no cadastro do contato
	const senderPhoto = isGroup ? null : (body?.photo || body?.senderPhoto || null);
	const status = body?.status || null;
	const messageId = body?.messageId || null;
	const replyId = body?.referenceMessageId;
	// Para edições do Z-API, o messageId contém o ID da mensagem original que foi editada
	const editedMessageId = (body?.isEdit === true && messageId) ? messageId : null;
	// Se for uma edição, o editMessageId (se existir) contém o ID da nova mensagem editada
	const newMessageId = (body?.isEdit === true && body?.editMessageId) ? body.editMessageId : messageId;
	
	let name = '';
	let groupName = null;
	
	if(isGroup){
		// Para grupos, extrai o nome do grupo para exibição
		groupName = body?.chatName || 'Grupo sem nome';
		if(!fromMe){
			name = body?.senderName || groupName;		
		}else{
			name = groupName;
		}
		
		// Se DESCONSIDERAR_GRUPO estiver true, desconsidera o grupo
		if(desconsiderarGrupo){
			console.log(`Dados de Grupo ${groupName}... Desconsiderando (DESCONSIDERAR_GRUPO=true).`);
			return { ignored: true, reason: 'group_disconsidered', origin: 'zapi', groupName };
		}
		// Se DESCONSIDERAR_GRUPO estiver false, processa o grupo usando o phone do payload como identificador
		console.log(`Processando mensagem de grupo: ${groupName} (phone: ${body?.phone})`);
		// Para grupos do Z-API, usa o phone do payload que vem no formato "*-group" (ex: "120363407124580783-group")
		// O phone do payload já está no formato correto para ser usado como identifier
		rawPhone = body?.phone || groupName; // Usa o phone do payload como identificador, fallback para nome do grupo
	} else {
		if(!fromMe){
			name = body?.senderName || body?.chatName || rawPhone || null;		
		}else{
			name = 	body?.chatName || rawPhone || null;
		}
	}
	// Extrai dados de imagem se presente
	const image = body?.image ? {
		imageUrl: body.image.imageUrl || '',
		base64: body.image.base64 || '',
		thumbnailUrl: body.image.thumbnailUrl,
		caption: body.image.caption || '',
		mimeType: body.image.mimeType,
		width: body.image.width,
		height: body.image.height
	} : null;

	// Extrai dados de áudio se presente
	const audio = body?.audio ? {
		audioUrl: body.audio.audioUrl || '',
		base64: body.audio.base64 || '',
		mimeType: body.audio.mimeType,
		ptt: body.audio.ptt || false,
		seconds: body.audio.seconds || 0,
		viewOnce: body.audio.viewOnce || false
	} : null;

	// Extrai dados de documento se presente
	const document = body?.document ? {
		documentUrl: body.document.documentUrl || '',
		base64: body.document.base64 || '',
		mimeType: body.document.mimeType,
		caption: body.document.caption || '',
		title: body.document.title || '',
		fileName: body.document.fileName || '',
		pageCount: body.document.pageCount || 0
	} : null;
	// Extrai dados de vídeo se presente
	const video = body?.video ? {
		videoUrl: body.video.videoUrl || '',
		base64: body.video.base64 || '',
		caption: body.video.caption || '',
		mimeType: body.video.mimeType,
		width: body.video.width,
		height: body.video.height,
		seconds: body.video.seconds || 0,
		viewOnce: body.video.viewOnce || false,
		isGif: body.video.isGif || false
	} : null;

	// Para grupos, não normaliza o phone (usa o phone do payload que vem no formato "*-group")
	// Para contatos normais, normaliza o phone para formato E.164
	const phone = isGroup ? rawPhone : normalizeToE164(rawPhone, defaultCountry);
	// Para grupos, extrai o senderName para exibir na mensagem
	const senderName = (isGroup && !fromMe) ? body?.senderName : null;
	// Se for uma edição, usa o newMessageId (ID da nova mensagem editada) para o mapeamento, senão usa o messageId normal
	const finalMessageId = newMessageId || messageId;
	return { phone, text, name, senderPhoto, image, audio, document, video, isGroup, fromMe, status, fromApi, messageId: finalMessageId, replyId, origin: 'zapi', groupName, senderName, editedMessageId };
}

/**
 * Extrai dados do payload UAZAPI
 */
function extractUazapiData(body, desconsiderarGrupo = true, defaultCountry = 'BR') {
	const message = body?.message;
	const chatData = body?.chat || {};

	if (!message) {
		console.warn('Payload UAZAPI sem dados de mensagem');
		return null;
	}
	// Extrai texto da mensagem
	let text = '';
	if (message?.content?.text) {
		text = message.content.text;
	} else if (message?.text) {
		text = message.text;
	}
	const fromMe = message?.fromMe || false;
	let rawPhone = message?.sender?.replace('@s.whatsapp.net', '') || message?.chatid?.replace('@s.whatsapp.net', '');
	const chatContactName = chatData?.name 
		|| chatData?.wa_name 
		|| chatData?.wa_contactName 
		|| body?.name 
		|| null;
	let name = '';
	if(!fromMe){
		name = message?.senderName || chatContactName || null;
	}else{
		rawPhone = message?.chatid?.replace('@s.whatsapp.net', '');
		name = chatContactName || rawPhone || message?.senderName || null;
	}
	const isGroup = message?.isGroup || false;
	const groupName = message?.groupName || body?.chat?.name || '';
	const messageId = message?.messageid || message?.id || null;
	const status = message?.status || null;
	const fromApi = message?.wasSentByApi || false;
	const replyId = body?.message?.content?.contextInfo?.stanzaID || null;
	const editedMessageId = message?.edited || message?.editMessageId || null;
	
	// Verifica se é grupo
	if (isGroup) {
		// Se DESCONSIDERAR_GRUPO estiver true, desconsidera o grupo
		if(desconsiderarGrupo){
			console.log(`Dados de Grupo UAZAPI ${groupName || 'Unknown'}... Desconsiderando (DESCONSIDERAR_GRUPO=true).`);
			return { ignored: true, reason: 'group_disconsidered', origin: 'uazapi', groupName };
		}
		// Se DESCONSIDERAR_GRUPO estiver false, processa o grupo usando wa_chatid como identificador
		// Para grupos, usa wa_chatid do objeto chat como identificador (ex: "120363378985956346@g.us")
		const waChatId = body?.chat?.wa_chatid || message?.chatid || null;
		if (!waChatId) {
			console.warn(`Grupo UAZAPI sem wa_chatid: ${groupName}`);
			return { phone: null, text, name: groupName || 'Grupo sem nome', senderPhoto: null, image: null, audio: null, document: null, video: null, isGroup, fromMe, status, fromApi, messageId, origin: 'uazapi', groupName, senderName: null };
		}
		console.log(`Processando mensagem de grupo UAZAPI: ${groupName} (wa_chatid: ${waChatId})`);
		// Para grupos, usa o wa_chatid como identificador ao invés do phone
		rawPhone = waChatId;
		// Atualiza o name para o nome do grupo (usado apenas para exibição no Chatwoot)
		if(!fromMe){
			name = message?.senderName || groupName || 'Grupo sem nome';
		}else{
			name = groupName || 'Grupo sem nome';
		}
	}
	
	// Para grupos, não normaliza o phone (usa o wa_chatid diretamente)
	// Para contatos normais, normaliza o phone
	const phone = isGroup ? rawPhone : normalizeToE164(rawPhone, defaultCountry);
	
	// Para grupos, extrai o senderName para exibir na mensagem
	// Quando fromMe=false e é grupo, senderName é quem enviou a mensagem no grupo
	const senderName = (isGroup && !fromMe) ? message?.senderName : null;

	// Foto do contato (avatar)
	const senderPhoto = chatData?.imagePreview 
		|| chatData?.image 
		|| chatData?.thumbnail
		|| body?.imagePreview
		|| body?.image
		|| message?.senderProfilePic 
		|| null;

	// Extrai dados de imagem se presente
	const image = message?.mediaType === 'image' || message?.messageType === 'ImageMessage' ? {
		imageUrl: message?.content?.URL || '',
		base64: '', // Será baixado via endpoint /message/download
		thumbnailUrl: message?.content?.JPEGThumbnail || '',
		caption: text || '',
		mimeType: message?.content?.mimetype || 'image/jpeg',
		width: message?.content?.width || 0,
		height: message?.content?.height || 0
	} : null;

	// Extrai dados de áudio se presente
	const audio = message?.mediaType === 'ptt' || message?.messageType === 'AudioMessage' ? {
		audioUrl: message?.content?.URL || '',
		base64: '', // Será baixado via endpoint /message/download
		mimeType: message?.content?.mimetype || 'audio/ogg',
		ptt: message?.content?.PTT || false,
		seconds: message?.content?.seconds || 0,
		viewOnce: false
	} : null;
	// Extrai dados de documento se presente
	const document = message?.mediaType === 'document' || message?.messageType === 'DocumentMessage' ? {
		documentUrl: message?.content?.URL || '',
		base64: '', // Será baixado via endpoint /message/download
		mimeType: message?.content?.mimetype || 'application/octet-stream',
		caption: text || '',
		title: message?.content?.title || '',
		fileName: message?.content?.fileName || 'Documento',
		pageCount: message?.content?.pageCount || 0
	} : null;

	// Extrai dados de vídeo se presente
	const video = message?.mediaType === 'video' || message?.messageType === 'VideoMessage' ? {
		videoUrl: message?.content?.URL || '',
		base64: '', // Será baixado via endpoint /message/download
		caption: text || '',
		mimeType: message?.content?.mimetype || 'video/mp4',
		width: message?.content?.width || 0,
		height: message?.content?.height || 0,
		seconds: message?.content?.seconds || 0,
		viewOnce: message?.content?.viewOnce || false,
		isGif: false
	} : null;

	return { phone, text, name, senderPhoto, image, audio, document, video, isGroup, fromMe, status, fromApi, messageId, replyId, origin: 'uazapi', groupName, senderName, editedMessageId };
}

/**
 * Extrai dados do payload Wuzapi
 */
function extractWuzapiData(body, desconsiderarGrupo = true, defaultCountry = 'BR') {
	const eventInfo = body?.event?.Info;
	const eventMessage = body?.event?.Message;
	
	// Extrai o identificador do chat (pode ser LID ou JID)
	const rawChatId = eventInfo?.Chat || '';
	let phone, lid, jid;
	
	// Verifica se é LID (termina com @lid)
	if (rawChatId.endsWith('@lid')) {
		lid = rawChatId;
		phone = null; // Não temos o número real
		jid = null;
	} else if (rawChatId.endsWith('@s.whatsapp.net')) {
		// É JID, extrai o número
		jid = rawChatId;
		phone = normalizeToE164(rawChatId.replace('@s.whatsapp.net', ''), defaultCountry);
		lid = null;
	} else {
		// Fallback: tenta normalizar como número
		phone = rawChatId;
		lid = null;
		jid = null;
	}
	
	// Extrai texto da mensagem
	const text = eventMessage?.conversation || eventMessage?.extendedTextMessage?.text || eventMessage?.imageMessage?.caption || eventMessage?.videoMessage?.caption || eventMessage?.documentMessage?.caption || eventMessage?.audioMessage?.caption || '';
	
	// Verifica se é mensagem do agente
	const fromMe = eventInfo?.IsFromMe || false;

	// Extrai nome do remetente
	let name = '';
	if(!fromMe){
		name = eventInfo?.PushName || eventInfo?.Sender?.replace('@s.whatsapp.net', '') || null;
	}else{
		name = 	rawChatId || null;
	}
	
	// Verifica se é grupo
	const isGroup = eventInfo?.IsGroup || false;
	
	// Extrai ID da mensagem
	const messageId = eventInfo?.ID || null;
	
	// Para grupos, tenta extrair o nome do grupo
	let groupName = null;
	if(isGroup){
		// Tenta obter o nome do grupo do payload (pode variar dependendo da API)
		groupName = eventInfo?.GroupName || eventInfo?.ChatName || eventInfo?.Chat?.replace('@lid', '').replace('@g.us', '') || 'Grupo sem nome';
		
		// Se DESCONSIDERAR_GRUPO estiver true, desconsidera o grupo
		if(desconsiderarGrupo){
			console.log(`Dados de Grupo Wuzapi ${groupName}... Desconsiderando (DESCONSIDERAR_GRUPO=true).`);
			return { ignored: true, reason: 'group_disconsidered', origin: 'wuzapi', groupName };		
		}
		
		// Se DESCONSIDERAR_GRUPO estiver false, processa o grupo
		console.log(`Processando mensagem de grupo Wuzapi: ${groupName}`);
		// Para grupos, usa o nome do grupo como identificador
		// Se temos LID, mantém, senão usa o nome do grupo
		if(!lid){
			// Se não temos LID, usa o nome do grupo como identificador
			phone = groupName;
			lid = null;
			jid = null;
		}
		// Atualiza o name para o nome do grupo
		if(!fromMe){
			name = eventInfo?.PushName || groupName;
		}else{
			name = groupName;
		}
	}
	
	// Extrai dados de imagem se presente
	const image = eventMessage?.imageMessage ? {
		imageUrl: '', // URL vazia para forçar uso do base64 no envio
		base64: body.base64 || '',
		thumbnailUrl: eventMessage.imageMessage.JPEGThumbnail || '',
		caption: eventMessage.imageMessage.caption || '',
		mimeType: eventMessage.imageMessage.mimetype || '',
		width: eventMessage.imageMessage.width || 0,
		height: eventMessage.imageMessage.height || 0
	} : null;

	if(image?.base64){
		let b64 = image.base64;
		b64 = b64.replace(/\s+/g, '').replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
		const pad = b64.length % 4;
		if (pad) b64 += '='.repeat(4 - pad);
		image.base64 = b64;
	}
	
	// Extrai dados de áudio se presente
	const audio = eventMessage?.audioMessage ? {
		audioUrl: '',
		base64: body.base64 || '',
		mimeType: eventMessage.audioMessage.mimetype || '',
		ptt: eventMessage.audioMessage.ptt || false,
		seconds: eventMessage.audioMessage.seconds || 0,
		viewOnce: eventMessage.audioMessage.viewOnce || false
	} : null;

	if(audio?.base64){
		let b64 = audio.base64;
		b64 = b64.replace(/\s+/g, '').replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
		const pad = b64.length % 4;
		if (pad) b64 += '='.repeat(4 - pad);
		audio.base64 = b64;
	}
	
	// Extrai dados de documento se presente
	const document = eventMessage?.documentMessage ? {
		documentUrl: '',
		base64: body.base64 || '',
		mimeType: eventMessage.documentMessage.mimetype || '',
		caption: eventMessage.documentMessage.caption || '',
		title: eventMessage.documentMessage.title || '',
		fileName: eventMessage.documentMessage.fileName || '',
		pageCount: eventMessage.documentMessage.pageCount || 0
	} : null;

	if(document?.base64){
		let b64 = document.base64;
		b64 = b64.replace(/\s+/g, '').replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
		const pad = b64.length % 4;
		if (pad) b64 += '='.repeat(4 - pad);
		document.base64 = b64;
	}
	
	// Extrai dados de vídeo se presente
	const video = eventMessage?.videoMessage ? {
		videoUrl: '',
		base64: body.base64 || '',
		caption: eventMessage.videoMessage.caption || '',
		mimeType: eventMessage.videoMessage.mimetype || '',
		width: eventMessage.videoMessage.width || 0,
		height: eventMessage.videoMessage.height || 0,
		seconds: eventMessage.videoMessage.seconds || 0,
		viewOnce: eventMessage.videoMessage.viewOnce || false,
		isGif: eventMessage.videoMessage.isGif || false
	} : null;

	if(video?.base64){
		let b64 = video.base64;
		b64 = b64.replace(/\s+/g, '').replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/');
		const pad = b64.length % 4;
		if (pad) b64 += '='.repeat(4 - pad);
		video.base64 = b64;
	}
	
	// Para grupos, extrai o senderName para exibir na mensagem
	const senderName = (isGroup && !fromMe) ? (eventInfo?.PushName || eventInfo?.Sender?.replace('@s.whatsapp.net', '')) : null;
	return { phone, lid, jid, text, name, senderPhoto: null, image, audio, document, video, isGroup, fromMe, status: null, fromApi: false, messageId, origin: 'wuzapi', groupName, senderName };
}

/**
 * Função principal para extrair dados de qualquer origem
 */
function extractMessageData(body, desconsiderarGrupo = true, defaultCountry = 'BR') {
	const origin = detectPayloadOrigin(body);
	console.log(`Dados de API de Entrada. Usando ${origin}`);
	
	switch (origin) {
	case 'zapi':
		return extractZapiData(body, desconsiderarGrupo, defaultCountry);
	case 'uazapi':
		return extractUazapiData(body, desconsiderarGrupo, defaultCountry);
	case 'wuzapi':
		return extractWuzapiData(body, desconsiderarGrupo, defaultCountry);
	default:
		// Fallback para tentar extrair dados genéricos
		//eslint-disable-next-line no-case-declarations
		const rawPhone = body?.phone || body?.from || body?.number || body?.remoteJid;
		// eslint-disable-next-line no-case-declarations
		const phone = normalizeToE164(rawPhone, defaultCountry);
		// eslint-disable-next-line no-case-declarations
		const text = body?.text || body?.message || body?.body || '';
		// eslint-disable-next-line no-case-declarations
		const name = body?.name || body?.contact?.name || null;
		// eslint-disable-next-line no-case-declarations
		const isGroup = true; //para ser desconsiderado
		// eslint-disable-next-line no-case-declarations
		const fromMe = body?.fromMe || false;
		// eslint-disable-next-line no-case-declarations
		const image = body?.image || null;
		// eslint-disable-next-line no-case-declarations
		const audio = body?.audio || null;
		// eslint-disable-next-line no-case-declarations
		const document = body?.document || null;
		// eslint-disable-next-line no-case-declarations
		const video = body?.video || null;
		// eslint-disable-next-line no-case-declarations
		const lid = null;
		// eslint-disable-next-line no-case-declarations
		const jid = null;
		// eslint-disable-next-line no-case-declarations
		const senderName = null;
		return { phone, lid, jid, text, name, senderPhoto: null, image, audio, document, video, isGroup, fromMe, status: null, fromApi: false, messageId: null, origin: 'unknown', groupName: null, senderName };
	}
}

async function processUazapiDeletedMessage(body, integrations = []) {
	try {
		const messageIds = body?.event?.MessageIDs;
		if (!Array.isArray(messageIds) || messageIds.length === 0) {
			console.warn('Evento de deleção UAZAPI sem MessageIDs');
			return { processed: false, reason: 'no_message_ids' };
		}

		const results = [];

		for (const apiMessageId of messageIds) {
			if (!apiMessageId) continue;

			const mapping = getChatwootMessageMappingByApiId(apiMessageId);
			if (!mapping?.chatwootMessageId) {
				console.warn(`Chatwoot messageId não encontrado para API messageId ${apiMessageId}`);
				results.push({
					apiMessageId,
					deleted: false,
					reason: 'chatwoot_message_not_found'
				});
				continue;
			}

			const chatwootMessageId = mapping.chatwootMessageId;
			const conversationId = mapping.conversationId;

			if (!conversationId) {
				console.warn(`ConversationId não encontrado para Chatwoot messageId ${chatwootMessageId}`);
				results.push({
					apiMessageId,
					chatwootMessageId,
					deleted: false,
					reason: 'conversation_id_not_found'
				});
				continue;
			}

			try {
				// Encontra a integração usando inboxId do mapeamento (se disponível)
				let integration = null;
				if (mapping?.inboxId) {
					integration = findIntegrationByInboxId(integrations, mapping.inboxId);
				}
				// Se não encontrou pelo inboxId, usa a primeira disponível
				if (!integration) {
					integration = integrations[0];
					if (mapping?.inboxId) {
						console.warn(`InboxId ${mapping.inboxId} do mapeamento não encontrado nas integrações. Usando primeira disponível.`);
					}
				}
				if (!integration) {
					throw new Error('Integração não encontrada para deletar mensagem');
				}
				
				await integration.chatwoot.deleteChatwootMessage(conversationId, chatwootMessageId);
				removeMessageIdMapping(chatwootMessageId);
				results.push({
					apiMessageId,
					chatwootMessageId,
					conversationId,
					deleted: true
				});
			} catch (error) {
				console.error(`Erro ao deletar mensagem no Chatwoot (chatwootId=${chatwootMessageId}, conversationId=${conversationId}):`, error?.response?.data || error?.message || error);
				results.push({
					apiMessageId,
					chatwootMessageId,
					conversationId,
					deleted: false,
					error: error?.message || 'unknown_error'
				});
			}
		}

		return {
			processed: true,
			type: 'uazapi_deleted',
			results
		};
	} catch (error) {
		console.error('Erro ao processar evento de deleção UAZAPI:', error);
		throw error;
	}
}

async function processZapiDeletedMessage(body, integrations = []) {
	try {
		const apiMessageId = body?.messageId || body?.message?.messageId || null;
		if (!apiMessageId) {
			console.warn('Evento de deleção Z-API sem messageId');
			return { processed: false, reason: 'zapi_message_id_not_found' };
		}

		const mapping = getChatwootMessageMappingByApiId(apiMessageId);
		if (!mapping?.chatwootMessageId) {
			console.warn(`Chatwoot messageId não encontrado para API messageId ${apiMessageId}`);
			return { processed: false, reason: 'chatwoot_message_not_found', apiMessageId };
		}

		const chatwootMessageId = mapping.chatwootMessageId;
		const conversationId = mapping.conversationId;

		if (!conversationId) {
			console.warn(`ConversationId não encontrado para Chatwoot messageId ${chatwootMessageId}`);
			return { processed: false, reason: 'conversation_id_not_found', chatwootMessageId, apiMessageId };
		}

		let integration = null;

		if (mapping?.inboxId) {
			integration = findIntegrationByInboxId(integrations, mapping.inboxId);
		}

		if (!integration) {
			const instanceId = body?.instanceId || body?.instance_id || body?.instance || null;
			if (instanceId) {
				integration = findIntegrationByWhatsAppIdentifier(integrations, 'zapi', instanceId);
				if (!integration) {
					console.warn(`Integração Z-API não encontrada para instanceId ${instanceId}. Tentando fallback.`);
				}
			}
		}

		if (!integration) {
			integration = integrations.find((i) => i.whatsapp.provider === 'zapi');
		}

		if (!integration) {
			throw new Error('Nenhuma integração Z-API disponível para processar deleção de mensagem.');
		}

		await integration.chatwoot.deleteChatwootMessage(conversationId, chatwootMessageId);
		removeMessageIdMapping(chatwootMessageId);

		return {
			processed: true,
			type: 'zapi_deleted',
			chatwootMessageId,
			conversationId,
			apiMessageId
		};
	} catch (error) {
		console.error('Erro ao processar evento de deleção Z-API:', error?.response?.data || error?.message || error);
		throw error;
	}
}

/**
 * Encontra a integração correta baseada no payload
 */
function findIntegrationForPayload(integrations, body, origin) {
	if (!integrations || integrations.length === 0) {
		throw new Error('Nenhuma integração configurada. Configure pelo menos uma integração usando variáveis de ambiente.');
	}
	
	// Se há apenas uma integração, usa ela
	if (integrations.length === 1) {
		const integration = integrations[0];
		if (integration.whatsapp.provider !== origin && origin !== 'unknown') {
			console.warn(`Aviso: A integração única (${integration.id}) usa ${integration.whatsapp.provider}, mas o payload indica origem ${origin}`);
		}
		return integration;
	}
	
	// Tenta encontrar por identificador do WhatsApp
	if (origin === 'uazapi') {
		// Para UAZAPI, tenta encontrar pelo número do WhatsApp
		// Primeiro tenta pelo owner (número conectado à instância)
		const owner = body?.owner || body?.message?.owner;
		if (owner) {
			const normalized = String(owner).replace(/[^0-9]/g, '');
			if (normalized) {
				const integration = findIntegrationByWhatsAppIdentifier(integrations, 'uazapi', normalized);
				if (integration) {
					console.log(`Integração UAZAPI encontrada pelo owner ${normalized}: ${integration.id}`);
					return integration;
				}
				console.warn(`Nenhuma integração UAZAPI configurada para o número conectado ${normalized}. Mensagem descartada.`);
				return null;
			}
		}

		// Tenta pelo número do WhatsApp no chatid ou no próprio payload
		const chatId = body?.message?.chatid?.replace('@s.whatsapp.net', '') || '';
		if (chatId) {
			const normalized = String(chatId).replace(/[^0-9]/g, '');
			if (normalized) {
				console.log(`Vai chamar função de FIND para num ${normalized}...`);
				const integration = findIntegrationByWhatsAppIdentifier(integrations, 'uazapi', normalized);
				console.log(`O retorno foi ${integration}!`);
				if (integration) {
					console.log(`Integração UAZAPI encontrada pelo chatid ${normalized}: ${integration.id}`);
					return integration;
				}
			}
		}
		
		
		console.warn('Não foi possível identificar integração UAZAPI para o payload recebido. Mensagem será descartada.');
		return null;
	} else if (origin === 'zapi') {
		const zapiIntegrations = integrations.filter(i => i.whatsapp.provider === 'zapi');
		if (zapiIntegrations.length === 1) {
			return zapiIntegrations[0];
		}
		if (zapiIntegrations.length > 1) {
			console.warn('Múltiplas integrações Z-API encontradas e payload não permite identificar qual usar. Mensagem será descartada.');
			return null;
		}
		console.warn('Nenhuma integração Z-API encontrada para o payload. Mensagem será descartada.');
		return null;
	} else if (origin === 'wuzapi') {
		const wuzapiIntegrations = integrations.filter(i => i.whatsapp.provider === 'wuzapi');
		if (wuzapiIntegrations.length === 1) {
			return wuzapiIntegrations[0];
		}
		if (wuzapiIntegrations.length > 1) {
			console.warn('Múltiplas integrações Wuzapi encontradas e payload não permite identificar qual usar. Mensagem será descartada.');
			return null;
		}
		console.warn('Nenhuma integração Wuzapi encontrada para o payload. Mensagem será descartada.');
		return null;
	}
	
	console.warn(`Origem ${origin} não mapeada ou sem integração correspondente. Mensagem será descartada.`);
	return null;
}

/**
 * Processa mensagem do webhook principal
 */
async function processWebhookPrincipal(body, integrations = []) {
	try {
		// Log do payload recebido para debug
		console.log('Payload da API de whatsapp retirado da Fila:', JSON.stringify(body, null, 2));
		//console.log('Integracoes são[]:', integrations);

		if (isUazapiDeletedEvent(body)) {
			return await processUazapiDeletedMessage(body, integrations);
		}

		if (isUazapiMessagesUpdateEvent(body)) {
			if (body?.type === 'DeletedMessage' || body?.EventType === 'messages_update') {
				console.log('Evento UAZAPI message_update ignorado (não é deleção). Estado:', body?.state, 'Tipo:', body?.type);
				return { processed: false, reason: 'uazapi_messages_update_non_deleted' };
			}
		}

		if (isZapiRevokeEvent(body)) {
			return await processZapiDeletedMessage(body, integrations);
		}

		if (isZapiNotificationEvent(body)) {
			console.log(`Evento de notificação Z-API (${body.notification}) ignorado para processamento de mensagem.`);
			return { processed: false, reason: 'zapi_notification_ignored', notification: body.notification };
		}

		// Detecta a origem primeiro para encontrar a integração
		const origin = detectPayloadOrigin(body);
		
		// Encontra a integração correta ANTES de extrair os dados
		const integration = findIntegrationForPayload(integrations, body, origin);
		if (!integration) {
			console.warn(`Nenhuma integração correspondente encontrada para processar o webhook (origem: ${origin}). Mensagem descartada.`);
			return { processed: false, reason: 'integration_not_found' };
		}
		
		// Usa as configurações da integração para extrair os dados
		const defaultCountry = integration.defaultCountry || 'BR';
		const desconsiderarGrupo = integration.desconsiderarGrupo !== false;
		
		console.log(`Integração encontrada: ${integration.id} (${integration.whatsapp.provider}) - DESCONSIDERAR_GRUPO=${desconsiderarGrupo}, DEFAULT_COUNTRY=${defaultCountry}`);

		// Extrai dados baseado na origem detectada, usando as configurações da integração
		const extractedData = extractMessageData(body, desconsiderarGrupo, defaultCountry);
		
		if (!extractedData) {
			console.log(`Extração de dados falhou ou retornou vazio para integração ${integration.id}`);
			return { processed: false, reason: 'message_extraction_failed' };
		}
		
		if (extractedData.ignored) {
			console.log(`Mensagem ignorada (${extractedData.reason || 'sem motivo'}) pela configuração da integração ${integration.id}`);
			return { processed: false, reason: extractedData.reason || 'message_ignored_by_config' };
		}
		
		const { phone, lid, jid, text, name, senderPhoto, image, audio, document, video, isGroup, fromMe, status, fromApi, messageId, replyId, groupName, senderName, editedMessageId } = extractedData;
		
		if (!phone && !lid && !jid && !text && !image && !audio && !document && !video) {
			console.log(`Mensagem ignorada pela configuração da integração ${integration.id}`);
			return { processed: false, reason: 'message_ignored_by_config' };
		}
		
		// Detecta o país do telefone para log
		const detectedCountry = detectCountryCode(phone);
		
		// Log para debug
		console.log(`Webhook recebido - Integração: ${integration.id}, Origem: ${origin}, Phone: ${phone}, Country: ${detectedCountry || defaultCountry}, Text: ${text?.substring(0, 50)}..., fromMe: ${fromMe}, fromApi: ${fromApi}, status: ${status}, Tem imagem: ${!!image}, Tem áudio: ${!!audio}, Tem documento: ${!!document}, Tem vídeo: ${!!video}, É grupo (${isGroup} - ${groupName})`);
		
		if (!phone || (!text && !image && !audio && !document && !video)) {
			console.warn(`Dados inválidos - Phone: ${phone}, Text: ${text}, Image: ${!!image}, Audio: ${!!audio}, Document: ${!!document}, Video: ${!!video}, Origin: ${origin}`);				
		}

		// Processa a mensagem no Chatwoot baseado no tipo (incoming ou outgoing)
		let result;
		if (fromMe && !fromApi) {
			// Mensagem do agente (fromMe: true || fromApi: false) - processa como outgoing
			console.log(`Processando envio de mensagem de agente (fromMe: ${fromMe} || fromApi: ${fromApi}) para ${phone}`);
			
			// Determina o tipo de mensagem ANTES de processar
			let messageType;
			if (image) messageType = 'image';
			else if (audio) messageType = 'audio';
			else if (video) messageType = 'video';
			else if (document) messageType = 'document';
			else messageType = 'text';
			
			//Adiciona ticket para nao ser processado no callback do chatwoot e dar loop			
			addOutgoingTicket(phone, messageType);
			try {
				result = await integration.chatwoot.processOutgoingMessage(phone, text, senderPhoto, name, image, audio, document, video, lid, jid, origin, messageId, isGroup, groupName);
				console.log(`Mensagem de agente enviada com sucesso para ${phone || lid || jid}:${messageType}`);
			} catch (error) {
				//retira ticket em caso de erro e impedir emperrar mensagens seguintes
				consumeOutgoingTicket(phone,messageType);
				console.log(`Erro no processamento de mensagem de agente para ${phone}:${messageType}`);
				throw error;
			}
							
		} else if (fromMe && fromApi) {
			// Mensagem do agente (fromMe: true || fromApi: true) - processa como outgoing
			console.log(`Processando envio de mensagem de agente (fromMe: ${fromMe} || fromApi: ${fromApi}) para ${phone}`);
			
			// Determina o tipo de mensagem ANTES de processar
			let messageType;
			if (image) messageType = 'image';
			else if (audio) messageType = 'audio';
			else if (video) messageType = 'video';
			else if (document) messageType = 'document';
			else messageType = 'text';

			if (consumeOutgoingTicketChatwoot(phone, messageType)) {
				// Adiciona ticket ANTES de processar a mensagem
				addOutgoingTicket(phone, messageType);
				try {
					result = await integration.chatwoot.processOutgoingMessage(phone, text, senderPhoto, name, image, audio, document, video, lid, jid, origin, messageId, isGroup, groupName);
					console.log(`Mensagem de agente enviada com sucesso para ${phone || lid || jid}:${messageType}`);
				} catch (error) {
					console.log(`Erro no processamento de mensagem de agente para ${phone}:${messageType}`);
					consumeOutgoingTicket(phone, messageType);//retira ticket adiconando anteriomente
					throw error;
				}
			} else {
				console.log(`Nenhum ticket encontrado para ${phone}:${messageType} - Processando mensagem de agente normalmente`);
			}
			
		} else {
			// Mensagem do cliente (fromMe: false) - processa como incoming
			console.log(`Processando envio de mensagem de cliente (fromMe: false) para ${phone || lid || jid}`);
			let chatwootMessageId = null;
			if(replyId){
				chatwootMessageId = getChatwootMessageId(replyId);
			}

			let editedReplyChatwootId = null;
			const formattedText = text;

			if (editedMessageId) {
				console.log(`Mensagem editada detectada - MessageId original (WhatsApp): ${editedMessageId}, MessageId nova mensagem: ${messageId}, Origin: ${origin}`);
				const mapping = getChatwootMessageMappingByApiId(editedMessageId);
				if (mapping?.chatwootMessageId) {
					editedReplyChatwootId = mapping.chatwootMessageId;
					console.log(`Mapeamento encontrado - Chatwoot MessageId: ${editedReplyChatwootId} para WhatsApp MessageId original: ${editedMessageId}`);
				} else {
					console.warn(`Mapeamento não encontrado para MessageId original (WhatsApp): ${editedMessageId}. A mensagem será processada normalmente sem reply.`);
				}
			}

			const replyChatwootId = editedReplyChatwootId || chatwootMessageId;

			if (editedMessageId && editedReplyChatwootId) {
				const editedContent = text ? `${text}\n(*mensagem editada pelo usuário*)` : '(*mensagem editada pelo usuário*)';
				result = await integration.chatwoot.processIncomingMessage(
					phone,
					editedContent,
					senderPhoto,
					name,
					null,
					null,
					null,
					null,
					lid,
					jid,
					origin,
					messageId,
					editedReplyChatwootId,
					isGroup,
					groupName,
					senderName
				);
				console.log(`Mensagem editada processada - Reply para Chatwoot ID ${editedReplyChatwootId} - Contact: ${result.contactId}, Conversation: ${result.conversationId}, Message: ${result.messageId}`);
			} else {
				result = await integration.chatwoot.processIncomingMessage(
					phone,
					formattedText,
					senderPhoto,
					name,
					image,
					audio,
					document,
					video,
					lid,
					jid,
					origin,
					messageId,
					replyChatwootId,
					isGroup,
					groupName,
					senderName
				);
				console.log(`Mensagem enviada - Tipo: ${fromMe ? 'AGENTE' : 'CLIENTE'} - Contact: ${result.contactId}, Conversation: ${result.conversationId}, Message: ${result.messageId}`);
			}
		}
		
		return { processed: true, result };
		//}//else do grupo
	} catch (error) {
		console.error('Erro ao processar webhook principal:', error);
		throw error;
	}
}

/**
 * Processa exclusão de mensagem do webhook callback
 */
async function processMessageDelete(body, integrations = []) {
	try {
		console.log('Processando exclusão de mensagem do Chatwoot:', JSON.stringify(body, null, 2));
		
		// Verifica se é uma mensagem de saída (do agente)
		if (body.message_type !== 'outgoing') {
			return { processed: false, reason: 'message_not_outgoing' };
		}
		
		// Verifica se é uma mensagem privada do agente
		if (body.private === true) {
			return { processed: false, reason: 'mensagem_privada' };
		}
		
		// Valida se há integrações configuradas
		if (!integrations || integrations.length === 0) {
			console.error('Nenhuma integração configurada para processar exclusão de mensagem');
			return { processed: false, reason: 'no_integrations_configured' };
		}
		
		// Extrai o ID da mensagem do Chatwoot
		const chatwootMessageId = body.id;
		if (!chatwootMessageId) {
			console.warn('ID da mensagem do Chatwoot não encontrado no payload de exclusão');
			return { processed: false, reason: 'chatwoot_message_id_not_found' };
		}
		
		// Recupera o ID da mensagem do WhatsApp usando o mapeamento
		const whatsAppMessageId = getApiMessageId(chatwootMessageId);
		if (!whatsAppMessageId) {
			console.warn(`ID da mensagem do WhatsApp não encontrado para Chatwoot ID: ${chatwootMessageId}. A mensagem pode não ter sido enviada via API do WhatsApp.`);
			return { processed: false, reason: 'whatsapp_message_id_not_found', chatwootMessageId };
		}
		
		console.log(`Deletando mensagem no WhatsApp - Chatwoot ID: ${chatwootMessageId}, WhatsApp ID: ${whatsAppMessageId}`);
		
		// Encontra a integração pela inboxId da conversa ou pelo mapeamento
		let integration = null;
		const inboxId = body.conversation?.inbox_id;
		
		if (inboxId) {
			integration = findIntegrationByInboxId(integrations, inboxId);
		}
		
		// Se não encontrou pelo inboxId, tenta pelo mapeamento
		if (!integration) {
			const mapping = getMessageMappingByChatwootId(chatwootMessageId);
			if (mapping?.inboxId) {
				integration = findIntegrationByInboxId(integrations, mapping.inboxId);
			}
		}
		
		// Fallback: primeira integração disponível
		if (!integration) {
			integration = integrations[0];
			if (!integration) {
				throw new Error('Integração não encontrada para deletar mensagem no WhatsApp');
			}
			console.warn(`InboxId não encontrado. Usando primeira integração disponível (${integration.id}) para deletar mensagem.`);
		}
		
		// Determina o identificador do contato para provedores que exigem phone/grupo
		let recipientForDeletion = null;
		const contact = body.conversation?.meta?.sender;
		if (contact) {
			const identifier = contact.identifier || contact.phone_number || null;
			const phoneNumber = contact.phone_number || null;
			// Detecta grupos: @g.us (UAZAPI) ou formato *-group (Z-API)
			const isGroup = identifier?.endsWith('@g.us') || identifier?.endsWith('-group') || false;
			
			if (isGroup && identifier) {
				// Para grupos do UAZAPI, usa o identifier que contém o wa_chatid (ex: "120363378985956346@g.us")
				// Para grupos do Z-API, usa o identifier que contém o formato "*-group" (ex: "120363407124580783-group")
				recipientForDeletion = identifier;
			} else {
				recipientForDeletion = phoneNumber || identifier || null;
			}
		}

		if (!recipientForDeletion) {
			console.warn('Recipient não encontrado no payload de exclusão. Alguns provedores podem exigir este valor para deletar mensagens.');
		}

		// Deleta a mensagem no WhatsApp
		let result;
		try {
			result = await integration.whatsapp.deleteMessage(whatsAppMessageId, {
				recipient: recipientForDeletion,
				owner: true
			});
			console.log('Mensagem deletada no WhatsApp:', JSON.stringify(result, null, 2));
			
			// Remove o mapeamento após deletar com sucesso
			removeMessageIdMapping(chatwootMessageId);
			
		} catch (error) {
			console.error(`Erro ao deletar mensagem no WhatsApp para Chatwoot ID ${chatwootMessageId}:`, error?.response?.data || error?.message);
			throw error;
		}
		
		return { 
			processed: true, 
			result,
			chatwoot_message_id: chatwootMessageId,
			whatsapp_message_id: whatsAppMessageId
		};
		
	} catch (error) {
		console.error('Erro ao processar exclusão de mensagem:', error);
		throw error;
	}
}

/**
 * Processa mensagem do webhook callback
 */
async function processWebhookCallback(body, integrations = []) {
	try {
		
		if (body.event === 'message_created' || body.event === 'message_updated') {
			console.log('Callback do Chatwoot retirado da Fila:', JSON.stringify(body, null, 2));
		}
		
		// Verifica se é um evento de mensagem atualizada com deleted=true (exclusão de mensagem)
		if (body.event === 'message_updated' && body.content_attributes?.deleted === true) {
			return await processMessageDelete(body, integrations);
		}
		
		// Verifica se é um evento de mensagem criada
		if (body.event !== 'message_created' ) {
			return { processed: false, reason: 'event_not_message_created' };
		}
		
		// Verifica se é uma mensagem de saída (do agente)
		if (body.message_type !== 'outgoing') {
			return { processed: false, reason: 'message_not_outgoing' };
		}
		
		// Verifica se é uma mensagem privada do agente		
		if (body.private === true) {
			return { processed: false, reason: 'mensagem_privada' };
		}
		
		// Valida se há integrações configuradas
		if (!integrations || integrations.length === 0) {
			console.error('Nenhuma integração configurada para processar callback');
			return { processed: false, reason: 'no_integrations_configured' };
		}
		
		// Extrai dados da conversa
		const conversation = body.conversation;
		if (!conversation) {
			console.warn('Conversa não encontrada no payload do callback');
			return { processed: false, reason: 'conversation_not_found' };
		}
		
		// Extrai dados do contato da conversa
		const contact = conversation.meta?.sender;
		if (!contact?.identifier) {
			console.warn('Identificador do contato não encontrado no payload do callback');
			return { processed: false, reason: 'contact_identifier_not_found', conversationId: conversation?.id };
		}
		
		const phone = contact.phone_number || null;
		const identifier = contact.identifier;
		
		// Determina se o identificador é LID, JID, wa_chatid de grupo (@g.us), formato grupo Z-API (-group) ou phone
		let lid = null, jid = null;
		let isGroup = false;
		
		if (identifier?.endsWith('@lid')) {
			lid = identifier;
		} else if (identifier?.endsWith('@s.whatsapp.net')) {
			jid = identifier;
		} else if (identifier?.endsWith('@g.us')) {
			// É um grupo do UAZAPI - wa_chatid termina com @g.us
			// Para grupos, o identifier contém o wa_chatid (ex: "120363378985956346@g.us")
			isGroup = true;
		} else if (identifier?.endsWith('-group')) {
			// É um grupo do Z-API - formato "*-group" (ex: "120363407124580783-group")
			isGroup = true;
		}
		
		// Para grupos: usa o identifier (que contém o wa_chatid para UAZAPI ou formato "*-group" para Z-API)
		// Grupos não têm phone_number válido
		// Para contatos normais: prioriza phone_number, depois LID, depois JID, depois identifier
		let recipient;
		if (isGroup) {
			// Para grupos do UAZAPI, usa o identifier que contém o wa_chatid (ex: "120363378985956346@g.us")
			// Para grupos do Z-API, usa o identifier que contém o formato "*-group" (ex: "120363407124580783-group")
			// Grupos não têm phone_number porque o Chatwoot valida formato E.164
			recipient = identifier;
		} else {
			// Para contatos normais, usa phone_number ou LID/JID
			recipient = phone || lid || jid || identifier;
		}
		
		if (!recipient) {
			console.warn('Nenhum identificador válido encontrado');
			return { processed: false, reason: 'no_valid_identifier_found' };
		}
		let content = body.content ?? '';
		const attachments = body.attachments || [];
		
		// Verifica se é uma mensagem de reply
		const replyToMessageId = body.content_attributes?.in_reply_to || null;
		let apiReplyMessageId = null;
		
		if (replyToMessageId) {
			console.log(`Mensagem é um reply para Chatwoot ID: ${replyToMessageId}`);
			apiReplyMessageId = getApiMessageId(replyToMessageId);
			if (apiReplyMessageId) {
				console.log(`MessageId da API encontrado para reply: ${apiReplyMessageId}`);
			} else {
				console.log(`MessageId da API não encontrado para reply do Chatwoot ID: ${replyToMessageId}`);
			}
		}
		
		// Determina o tipo de mensagem para verificação de tickets
		const messageType = getMessageType(content, attachments);

		// Encontra a integração pela inboxId
		const inboxId = conversation.inbox_id;
		let integration = null;
		
		if (inboxId) {
			integration = findIntegrationByInboxId(integrations, inboxId);
			if (!integration) {
				console.warn(`Integração não encontrada pelo inboxId ${inboxId}. Tentando usar primeira integração disponível.`);
			}
		}
		
		// Fallback: primeira integração disponível
		if (!integration) {
			if (integrations.length === 0) {
				throw new Error('Nenhuma integração configurada para processar callback. Configure pelo menos uma integração.');
			}
			integration = integrations[0];
			if (inboxId) {
				console.warn(`Usando primeira integração disponível (${integration.id}) - inboxId ${inboxId} não encontrado nas integrações.`);
			} else {
				console.log(`Usando primeira integração disponível (${integration.id}) - inboxId não fornecido no payload.`);
			}
		}
		
		const shouldSignMessages = integration.assinarMensagem !== false;
		
		// Extrai o nome do sender/agente do payload do Chatwoot
		// Prioridade: assignee.available_name > assignee.name > sender.name > sender.available_name
		const senderName = conversation.meta?.assignee?.available_name 
			|| conversation.meta?.assignee?.name 
			|| body?.sender?.name 
			|| body?.sender?.available_name 
			|| conversation.meta?.sender?.name
			|| '';

		if (shouldSignMessages && senderName) {
			// Formata o nome do sender e adiciona quebra somente se houver conteúdo
			const signature = `*${senderName}:*`;
			if (typeof content === 'string' && content.trim().length > 0) {
				content = `${signature}\n\n${content}`;
			} else {
				// Sem conteúdo adicional: apenas assinatura, sem quebras
				content = signature;
			}
		} else if (shouldSignMessages && !senderName) {
			console.warn(`ASSINAR_MENSAGEM ativado mas nome do sender não encontrado no payload. Campos disponíveis: assignee=${!!conversation.meta?.assignee}, sender=${!!body?.sender}`);
		}
		
		// Verifica se existe ticket disponível e o consome
		if (consumeOutgoingTicket(recipient, messageType)) {
			return { 
				processed: false, 
				reason: 'ticket_consumed',
				recipient,
				messageType
			};
		}
		
		// Processa todos os attachments (múltiplas mídias)
		const processedAttachments = [];
		
		if (attachments.length > 0) {
			for (const attachment of attachments) {
				let processedAttachment = null;
				
				switch (attachment.file_type) {
				case 'audio':
					processedAttachment = {
						type: 'audio',
						url: attachment.data_url,
						fileSize: attachment.file_size
					};
					break;
				case 'image':
					processedAttachment = {
						type: 'image',
						url: attachment.data_url,
						thumbUrl: attachment.thumb_url,
						width: attachment.width,
						height: attachment.height
					};
					break;
				case 'video':
					processedAttachment = {
						type: 'video',
						url: attachment.data_url,
						thumbUrl: attachment.thumb_url,
						width: attachment.width,
						height: attachment.height
					};
					break;
				case 'file':
					processedAttachment = {
						type: 'document',
						url: attachment.data_url,
						fileName: attachment.extension || attachment.data_url.split('/').pop() || 'documento',
						fileSize: attachment.file_size
					};
					break;
				default:
					break;
				}
				
				if (processedAttachment) {					
					processedAttachments.push(processedAttachment);
				}
				addOutgoingTicketChatwoot(recipient, messageType);//um para cada mídia
			}
		} else{
			// Adiciona ticket ANTES de enviar a mensagem no WhatsApp
			addOutgoingTicketChatwoot(recipient, messageType);
		}
		
		console.log(`Enviando mensagem para WhatsApp - Recipient: ${recipient}, Type: ${messageType}, Content: ${content?.substring(0, 50)}..., Attachments: ${processedAttachments.length}, IsGroup: ${isGroup}`);
		
		// Envia mensagem no WhatsApp
		// Para grupos: recipient contém o wa_chatid (ex: "120363378985956346@g.us")
		// Para contatos normais: recipient contém phone_number ou LID/JID
		let result;
		try {
			// Usa recipient ao invés de phone para garantir que grupos usem o wa_chatid correto
			result = await integration.whatsapp.sendMessage(recipient, content, messageType, processedAttachments, lid, jid, apiReplyMessageId);
			console.log('Mensagem enviada no WhatsApp:', JSON.stringify(result,null,2));
			const apiMessageIds = extractApiMessageIds(result);
			if (apiMessageIds.length > 0) {
				const messageId = apiMessageIds[0];
				const inboxId = conversation.inbox_id;
				storeMessageIdMapping(body.id, messageId, conversation.id, inboxId, integration.whatsapp.provider, integration.id);
			} else {
				console.warn('Não foi possível extrair messageId da resposta do provedor para mapear o reply.');
			}
		} catch (error) {
			// Se houver erro, remove o ticket
			consumeOutgoingTicketChatwoot(recipient, messageType);
			console.log(`Erro no envio - Ticket removido para ${recipient}:${messageType}`);
			throw error;
		}
		
		return { 
			processed: true, 
			result,
			recipient,
			phone,
			lid,
			jid,
			message_type: messageType,
			content_length: content?.length || 0,
			attachments_count: processedAttachments.length,
			attachments: processedAttachments,
			conversation_id: conversation.id,
			message_id: body.id,
			is_reply: !!replyToMessageId,
			reply_to_chatwoot_id: replyToMessageId,
			reply_to_api_id: apiReplyMessageId
		};
		
	} catch (error) {
		console.error('Erro ao processar webhook callback:', error);
		throw error;
	}
}

/**
 * Inicia o consumer do webhook principal
 */
async function startWebhookPrincipalConsumer(integrations = []) {
	try {
		const { js, sc } = await getNatsConnection();

		const opts = consumerOpts();
		opts.durable('consumer-webhook-principal');     // consumer persistente
		opts.manualAck();                     // ack explícito
		opts.deliverTo('webhook-principal-consumer');						
	
		// IMPORTANTE: o subject tem que existir no stream		
		const sub = await js.subscribe('webhook.principal', opts);

		console.log('✓ Consumer do Webhook Principal iniciado e aguardando requisições...');

		for await (const m of sub){
			try {
				const body = JSON.parse(sc.decode(m.data));
				await processWebhookPrincipal(body, integrations);
				m.ack(); // dá baixa no payload da fila
			} catch (error) {
				console.error('[startWebhookPrincipalConsumer]: Erro ao processar mensagem do webhook principal:', error?.message || error);
				if (error?.stack && process.env.LOG_LEVEL === 'debug') {
					console.error('Stack trace:', error.stack);
				}
				// Em caso de erro, ainda faz o ack para não travar a fila
				m.ack();
			}
		}
	} catch (err) {
		console.error('Erro no consumer do webhook principal:', err);
		throw err;
	}
}

/**
 * Inicia o consumer do webhook callback
 */
async function startWebhookCallbackConsumer(integrations = []) {
	try {
		const { js, sc } = await getNatsConnection();

		const opts = consumerOpts();
		opts.durable('consumer-webhook-callback');     // consumer persistente
		opts.manualAck();                     // ack explícito
		opts.deliverTo('webhook-callback-consumer');						
	
		// IMPORTANTE: o subject tem que existir no stream		
		const sub = await js.subscribe('webhook.callback', opts);

		console.log('✓ Consumer do Webhook Callback iniciado e aguardando requisições...');

		for await (const m of sub){
			try {
				const body = JSON.parse(sc.decode(m.data));
				await processWebhookCallback(body, integrations);
				m.ack(); // dá baixa no payload da fila
			} catch (error) {
				console.error('[startWebhookCallbackConsumer]: Erro ao processar mensagem do webhook callback:', error?.message || error);
				if (error?.stack && process.env.LOG_LEVEL === 'debug') {
					console.error('Stack trace:', error.stack);
				}
				// Em caso de erro, ainda faz o ack para não travar a fila
				m.ack();
			}
		}
	} catch (err) {
		console.error('Erro no consumer do webhook callback:', err);
		throw err;
	}
}

export { 
	startWebhookPrincipalConsumer, 
	startWebhookCallbackConsumer 
};
