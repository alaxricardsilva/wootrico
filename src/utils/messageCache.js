'use strict';

// Sistema de crédito/ticket para controlar mensagens outgoing
// Estrutura: { phone: { messageType: ticketCount } }
const messageTickets = new Map();
const messageTicketsChatwoot = new Map();

// Sistema de cache para associar messageId da API com ID/conversa do Chatwoot
// Estrutura: { chatwootMessageId: { apiMessageId, conversationId } }
const messageIdCache = new Map();

/**
 * Tipos de mensagem suportados
 */
const MESSAGE_TYPES = {
	TEXT: 'text',
	IMAGE: 'image',
	AUDIO: 'audio',
	VIDEO: 'video',
	DOCUMENT: 'document'
};

/**
 * Determina o tipo de mensagem baseado no conteúdo
 * @param {string} content - Conteúdo da mensagem
 * @param {Array} attachments - Anexos da mensagem
 * @returns {string} - Tipo da mensagem
 */
function getMessageType(content, attachments = []) {
	if (attachments && attachments.length > 0) {
		const firstAttachment = attachments[0];
		switch (firstAttachment.file_type) {
		case 'audio':
			return MESSAGE_TYPES.AUDIO;
		case 'image':
			return MESSAGE_TYPES.IMAGE;
		case 'video':
			return MESSAGE_TYPES.VIDEO;
		case 'file':
			return MESSAGE_TYPES.DOCUMENT;
		default:
			return MESSAGE_TYPES.TEXT;
		}
	}
	return MESSAGE_TYPES.TEXT;
}

/**
 * Adiciona um ticket para uma mensagem outgoing (incrementa o contador)
 * @param {string} phone - Número do telefone
 * @param {string} messageType - Tipo da mensagem
 */
function addOutgoingTicket(phone, messageType) {
	if (!messageTickets.has(phone)) {
		messageTickets.set(phone, {});
	}
	
	const phoneTickets = messageTickets.get(phone);
	phoneTickets[messageType] = (phoneTickets[messageType] || 0) + 1;
	
	//console.log(`Ticket adicionado para ${phone}:${messageType} - Total: ${phoneTickets[messageType]}`);
}

/**
 * Verifica se existe ticket disponível e o consome (decrementa)
 * @param {string} phone - Número do telefone
 * @param {string} messageType - Tipo da mensagem
 * @returns {boolean} - true se havia ticket disponível e foi consumido
 */
function consumeOutgoingTicket(phone, messageType) {
	if (!messageTickets.has(phone)) {
		//console.log('consumeTicket: retornando false pois nao encontrou chave',phone);
		return false;
	}
	
	const phoneTickets = messageTickets.get(phone);
	const currentTickets = phoneTickets[messageType] || 0;
	
	if (currentTickets > 0) {
		phoneTickets[messageType] = currentTickets - 1;
		//console.log(`Ticket consumido para ${phone}:${messageType} - Restante: ${phoneTickets[messageType]}`);
		
		// Remove o phone se não há mais tickets de nenhum tipo
		const hasAnyTickets = Object.values(phoneTickets).some(count => count > 0);
		if (!hasAnyTickets) {
			messageTickets.delete(phone);
			//console.log(`Phone ${phone} removido do sistema de tickets`);
		}
		
		return true;
	}
	//console.log(`Retornando false para ${phone}:${messageType} pois zerou os tickets`);	
	return false;
}


/**
 * Adiciona um ticket para uma mensagem outgoing (incrementa o contador)
 * @param {string} phone - Número do telefone
 * @param {string} messageType - Tipo da mensagem
 */
function addOutgoingTicketChatwoot(phone, messageType) {
	if (!messageTicketsChatwoot.has(phone)) {
		messageTicketsChatwoot.set(phone, {});
	}
	
	const phoneTickets = messageTicketsChatwoot.get(phone);
	phoneTickets[messageType] = (phoneTickets[messageType] || 0) + 1;
	
	console.log(`Ticket adicionado de CALLBACK para ${phone}:${messageType} - Total: ${phoneTickets[messageType]}`);
}

/**
 * Verifica se existe ticket disponível e o consome (decrementa)
 * @param {string} phone - Número do telefone
 * @param {string} messageType - Tipo da mensagem
 * @returns {boolean} - true se havia ticket disponível e foi consumido
 */
function consumeOutgoingTicketChatwoot(phone, messageType) {
	if (!messageTicketsChatwoot.has(phone)) {
		console.log('consumeTicketChatwoot: retornando true pois nao encontrou chave',phone);
		return true;
	}
	
	const phoneTickets = messageTicketsChatwoot.get(phone);
	const currentTickets = phoneTickets[messageType] || 0;
	
	if (currentTickets > 0) {
		phoneTickets[messageType] = currentTickets - 1;
		console.log(`consumeTicketChatwoot: Ticket consumido para ${phone}:${messageType} - Restante: ${phoneTickets[messageType]}`);
		
		// Remove o phone se não há mais tickets de nenhum tipo
		const hasAnyTickets = Object.values(phoneTickets).some(count => count > 0);
		if (!hasAnyTickets) {
			messageTicketsChatwoot.delete(phone);
			console.log(`Phone ${phone} removido do sistema de tickets`);
		}
		
		return false;
	}
	console.log(`Retornando true para ${phone}:${messageType} pois zerou os tickets`);	
	return true;
}
/**
 * Obtém estatísticas do sistema de tickets
 * @returns {object} - Estatísticas dos tickets
 */
function getTicketStats() {
	const stats = {
		totalPhones: messageTickets.size,
		phones: {}
	};
	
	for (const [phone, phoneTickets] of messageTickets.entries()) {
		stats.phones[phone] = { ...phoneTickets };
	}
	
	return stats;
}

/**
 * Armazena associação entre ID da mensagem do Chatwoot e messageId da API
 * @param {string|number} chatwootMessageId - ID da mensagem no Chatwoot
 * @param {string} apiMessageId - messageId retornado pela API do WhatsApp
 * @param {string|number} conversationId - ID da conversa no Chatwoot
 * @param {string|number} inboxId - ID da inbox no Chatwoot (opcional, para melhor rastreamento)
 */
function storeMessageIdMapping(chatwootMessageId, apiMessageId, conversationId = null, inboxId = null, provider = null, integrationId = null) {
	const entry = {
		apiMessageId,
		conversationId: conversationId ? String(conversationId) : null,
		inboxId: inboxId ? String(inboxId) : null,
		provider: provider || null,
		integrationId: integrationId ? String(integrationId) : null
	};

	messageIdCache.set(String(chatwootMessageId), entry);
	console.log(`Mapeamento armazenado: Chatwoot ID ${chatwootMessageId} -> API ID ${apiMessageId}, Conversation ID ${conversationId}${inboxId ? `, Inbox ID ${inboxId}` : ''}${provider ? `, Provider ${provider}` : ''}${integrationId ? `, Integration ${integrationId}` : ''}`);
}

/**
 * Recupera o messageId da API baseado no ID da mensagem do Chatwoot
 * @param {string|number} chatwootMessageId - ID da mensagem no Chatwoot
 * @returns {string|null} - messageId da API ou null se não encontrado
 */
function getApiMessageId(chatwootMessageId) {
	const entry = messageIdCache.get(String(chatwootMessageId));
	const apiMessageId = entry?.apiMessageId;
	if (apiMessageId) {
		console.log(`Mapeamento encontrado: Chatwoot ID ${chatwootMessageId} -> API ID ${apiMessageId}`);
	} else {
		console.log(`Mapeamento não encontrado para Chatwoot ID ${chatwootMessageId}`);
	}
	return apiMessageId || null;
}

function getChatwootMessageId(apiMessageId) {
	for (const [key, value] of messageIdCache.entries()) {
		if (value?.apiMessageId === apiMessageId) {
			console.log(`Encontrado messageID de Chatwoot encontrado: Chatwoot ID ${key} -> API ID ${apiMessageId}`);
			return key; // retorna a chave correspondente
		}
	}
	console.log(`Não Encontrado messageID de Chatwoot encontrado: -> API ID ${apiMessageId}`);
	return null; // não encontrado
}

/**
 * Remove mapeamento de ID de mensagem
 * @param {string|number} chatwootMessageId - ID da mensagem no Chatwoot
 */
function removeMessageIdMapping(chatwootMessageId) {
	const removed = messageIdCache.delete(String(chatwootMessageId));
	if (removed) {
		console.log(`Mapeamento removido para Chatwoot ID ${chatwootMessageId}`);
	}
}

/**
 * Recupera o mapeamento completo (API ID e conversationId) baseado no Chatwoot ID
 * @param {string|number} chatwootMessageId
 * @returns {{apiMessageId: string|null, conversationId: string|null}|null}
 */
function getMessageMappingByChatwootId(chatwootMessageId) {
	return messageIdCache.get(String(chatwootMessageId)) || null;
}

/**
 * Recupera o mapeamento completo baseado no ID da API (WhatsApp)
 * @param {string} apiMessageId
 * @returns {{chatwootMessageId: string|null, conversationId: string|null, inboxId: string|null}|null}
 */
function getChatwootMessageMappingByApiId(apiMessageId) {
	for (const [key, value] of messageIdCache.entries()) {
		if (value?.apiMessageId === apiMessageId) {
			return {
				chatwootMessageId: key,
				conversationId: value?.conversationId || null,
				inboxId: value?.inboxId || null
			};
		}
	}
	return null;
}



/**
 * Limpa tickets antigos (mais de 1 hora) para evitar vazamento de memória
 */
function cleanupOldTickets() {
	// Por simplicidade, vamos limpar todos os tickets a cada hora
	// Em uma implementação mais robusta, poderíamos rastrear timestamps
	setTimeout(() => {
		messageTickets.clear();
		//messageTicketsChatwoot.clear();
		messageIdCache.clear(); // Limpa também o cache de IDs
		console.log('Tickets antigos e cache de IDs limpos');
		cleanupOldTickets(); // Agenda próxima limpeza
	}, 60 * 60 * 5000); // 5 hora
}

// Inicia o processo de limpeza
cleanupOldTickets();

export { 
	getMessageType,
	addOutgoingTicket, 
	consumeOutgoingTicket,
	addOutgoingTicketChatwoot, 
	consumeOutgoingTicketChatwoot,
	getTicketStats,
	storeMessageIdMapping,
	getApiMessageId,
	removeMessageIdMapping,
	getChatwootMessageId,	
	getMessageMappingByChatwootId,
	getChatwootMessageMappingByApiId,
	MESSAGE_TYPES
};
