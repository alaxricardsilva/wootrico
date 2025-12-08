import { connect, Empty, StringCodec } from 'nats';

let nc = null;
let js = null;
let jsm = null;
const sc = StringCodec();

export async function getNats() {
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
			jsm = await nc.jetstreamManager();
			
			console.log('[NATS] Conectado com sucesso a', servers);			
			
			
		} catch (error) {
			console.error('[NATS] Erro ao conectar:', error);
			throw error;
		}
	}
	return { nc, js, jsm, sc };
}

export async function publish(subject, obj) {
	try {
		const { js, sc } = await getNats();
		const data = sc.encode(typeof obj === 'string' ? obj : JSON.stringify(obj));
		const ack = await js.publish(subject, Empty, data);
		console.log(`[NATS] Mensagem publicada em ${subject} - seq: ${ack.seq}`);
		return ack;
	} catch (error) {
		console.error(`[NATS] Erro ao publicar em ${subject}:`, error);
		throw error;
	}
}