'use strict';

import express, { Router } from 'express';
import { getTicketStats } from '../utils/messageCache.js';
import { publishWebhookPrincipal, publishWebhookCallback } from '../services/webhookPublisher.js';

const router = Router();

// Configuração específica para webhooks com limite aumentado
router.use(express.json({ limit: '500mb' }));
router.use(express.urlencoded({ limit: '500mb', extended: true }));

// Webhook que recebe mensagens do Z-API, UAZAPI e Wuzapi
router.post('/', async (req, res) => {
	try {
		const body = req.body?.body || req.body || {};
		
		// Log do payload recebido para debug
		console.log('Payload da API de whatsapp recebido:', JSON.stringify(body, null, 2));

		console.log('Publicando em NATS...');
		await publishWebhookPrincipal(body);
		console.log('Requisição Enfileirada em NATS!');
		return res.status(200).json({ accepted: true, queued: 'webhook.principal' });
		
	} catch (err) {
		console.error('Erro no webhook Principal:', err?.response?.data || err?.message || err);
		return res.status(500).json({ 
			error: 'internal_error',
			message: err?.message || 'Erro interno do servidor'
		});
	}
});

// Webhook de callback do Chatwoot para enviar mensagens no WhatsApp
router.post('/callback', async (req, res) => {
	try {
		const body = req.body?.body || req.body || {};
				
		console.log('Callback do Chatwoot recebido:', JSON.stringify(body, null, 2));
		
		console.log('Publicando callback em NATS...');
		await publishWebhookCallback(body);
		console.log('Callback Enfileirado em NATS!');
		return res.status(200).json({ accepted: true, queued: 'webhook.callback' });
		
	} catch (err) {
		console.error('Erro no callback do Chatwoot:', err?.response?.data || err?.message || err);
		return res.status(500).json({ 
			error: 'internal_error',
			message: err?.message || 'Erro interno do servidor'
		});
	}
});

// Rota para verificar estatísticas dos tickets
router.get('/ticket-stats', (req, res) => {
	try {
		const stats = getTicketStats();
		return res.status(200).json(stats);
	} catch (err) {
		console.error('Erro ao obter estatísticas dos tickets:', err);
		return res.status(500).json({ error: 'internal_error' });
	}
});

export default router;
