'use strict';

import { connect, StringCodec } from 'nats';

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
			console.log('[NATS] Conectando a:', servers);
			
			nc = await connect({ 
				servers,
				timeout: 10000,
				reconnect: true,
				maxReconnectAttempts: 5
			});
			
			js = nc.jetstream();
			
			console.log('[NATS] Conectado com sucesso a', servers);
			
		} catch (error) {
			console.error('[NATS] Erro ao conectar:', error);
			throw error;
		}
	}
	return { nc, js, sc };
}

/**
 * Garante que o stream existe
 */
async function ensureStream() {
	try {
		const { nc } = await getNatsConnection();
		const jsm = await nc.jetstreamManager();
		const streamName = 'wootrico';
		
		try {
			const streamInfo = await jsm.streams.info(streamName);
			console.log(`[NATS] Stream ${streamName} já existe - subjects:`, streamInfo.config.subjects);
		} catch (error) {
			console.log(`[NATS] Criando stream ${streamName}...`);
			const streamConfig = {
				name: streamName,
				subjects: ['webhook.principal', 'webhook.callback']
			};
			
			await jsm.streams.add(streamConfig);
			console.log(`[NATS] Stream ${streamName} criado com sucesso`);
		}
	} catch (error) {
		console.error('[NATS] Erro ao garantir stream:', error);
		console.error('[NATS] Verifique se o NATS está rodando...');
		throw error;
	}
}

/**
 * Publica mensagem no stream
 */
async function publishMessage(subject, data) {
	try {
		const { js, sc } = await getNatsConnection();
		const encodedData = sc.encode(typeof data === 'string' ? data : JSON.stringify(data));
		const ack = await js.publish(subject, encodedData);
		console.log(`[NATS] Mensagem publicada em ${subject} - seq: ${ack.seq}`);
		return ack;
	} catch (error) {
		console.error(`[NATS] Erro ao publicar em ${subject}:`, error);
		throw error;
	}
}

/**
 * Publica mensagem do webhook principal
 */
async function publishWebhookPrincipal(payload) {
	return await publishMessage('webhook.principal', payload);
}

/**
 * Publica mensagem do webhook callback
 */
async function publishWebhookCallback(payload) {
	return await publishMessage('webhook.callback', payload);
}

export { 
	getNatsConnection, 
	ensureStream, 
	publishWebhookPrincipal, 
	publishWebhookCallback 
};
