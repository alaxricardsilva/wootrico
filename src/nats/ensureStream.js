// src/nats/ensureStream.js
import { getNats } from './natsClient.js';

/**
 * Garante a existência do stream "wootrico" com subjects:
 * - webhook.principal
 * - webhook.callback 
 */
export async function ensureStream() {
	try {
		const { jsm } = await getNats();
		const name = 'wootrico';
		
		try {
			const streamInfo = await jsm.streams.info(name);
			console.log(`[NATS] stream ${name} já existe - subjects:`, streamInfo.config.subjects);
		} catch (error) {
			console.log(`[NATS] criando stream ${name}...`);
			const streamConfig = {
				name,
				subjects: ['webhook.principal', 'webhook.callback']
			};
			
			await jsm.streams.add(streamConfig);
			console.log(`[NATS] stream ${name} criado com sucesso`);
			
			// Verifica se foi criado corretamente
			const createdStream = await jsm.streams.info(name);
			console.log('[NATS] stream criado - subjects:', createdStream.config.subjects);
		}
	} catch (error) {
		console.error('[NATS] Erro ao garantir stream:', error);
		throw error;
	}
}
