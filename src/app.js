'use strict';

import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

import webhooksRouter from './routes/webhooks.js';
import { ensureStream } from './services/webhookPublisher.js';

const app = express();

// Configuração do body-parser com limite aumentado para suportar payloads grandes
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());
app.use(morgan('combined'));

app.get('/health', (req, res) => {
	res.json({ status: 'ok' });
});

app.get('/webhook-url', (req, res) => {
	const baseUrl = process.env.WEBHOOK_BASE_URL;
	const webhookPath = process.env.WEBHOOK_NAME || 'wootrico';	

	res.json({
		webhook_url: `${baseUrl}/${webhookPath}`,
		callback_url: `${baseUrl}/${webhookPath}/callback`,
		base_url: baseUrl,
		path: webhookPath
	});
});

const webhookPath = `/${process.env.WEBHOOK_NAME || 'wootrico'}`;
app.use(webhookPath, webhooksRouter);

const port = Number(process.env.PORT || 3000);

// Executa bootstrap apenas no start do container
(async () => {

	app.listen(port, () => {
		// eslint-disable-next-line no-console
		console.log('');
		console.clear();
		console.log('============================================================');
		console.log('                    🚀 WOOTRICO 🚀                         ');
		console.log('============================================================');
		console.log('');
		console.log(`   Middleware Chatwoot ↔ Wootrico rodando na porta ${port}  `);
		console.log('');
		console.log('   Desenvolvido por: @erico.arenato (Instagram)             ');
		console.log('   Curso: AutoNext - Formação de Gestores de Automação      ');
		console.log('   Canal YouTube: Tutoriais completos sobre Wootrico        ');
		console.log('   Site: https://ericorenato.com.br                         ');
		console.log('');	

	});
	
	try {
		//checkAPIConfiguration();
		//await ensureInboxBootstrap();		
		await ensureStream().catch(console.error);//garante que o stream do nats vai executar
		
	} catch (err) {
		// eslint-disable-next-line no-console
		console.error('Falha no bootstrap da Inbox do Chatwoot:', err?.response?.data || err?.message || err);
	}

	
})();

export default app;


