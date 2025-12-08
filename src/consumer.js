'use strict';

import 'dotenv/config';
import { startWebhookPrincipalConsumer, startWebhookCallbackConsumer } from './services/webhookConsumer.js';
import { loadIntegrations } from './services/integrationManager.js';

console.log('============================================================');
console.log('                    🚀 WOOTRICO CONSUMER 🚀                ');
console.log('============================================================');
console.log('');
console.log('   Consumer NATS JetStream para processamento de mensagens   ');
console.log('');
console.log('   Desenvolvido por: @erico.arenato (Instagram)             ');
console.log('   Curso: AutoNext - Formação de Gestores de Automação      ');
console.log('   Canal YouTube: Tutoriais completos sobre Wootrico        ');
console.log('   Site: https://ericorenato.com.br                         ');
console.log('');

// Inicia os consumers em paralelo
(async () => {
	try {
		console.log('============================================================');
		console.log('        Carregando e Inicializando Integrações              ');
		console.log('============================================================\n');
		
		const integrations = await loadIntegrations();
		
		if (!integrations || integrations.length === 0) {
			throw new Error('Nenhuma integração foi carregada. Verifique as configurações das variáveis de ambiente.');
		}
		
		console.log('\n============================================================');
		console.log('        Iniciando Consumers NATS JetStream                  ');
		console.log('============================================================\n');
		
		// Inicia ambos os consumers em paralelo
		await Promise.all([
			startWebhookPrincipalConsumer(integrations),
			startWebhookCallbackConsumer(integrations)
		]);
		
	} catch (err) {
		console.error('\n============================================================');
		console.error('              ERRO FATAL AO INICIAR                        ');
		console.error('============================================================');
		console.error(`Erro: ${err?.message || err}`);
		if (err?.stack) {
			console.error('\nStack trace:');
			console.error(err.stack);
		}
		console.error('============================================================\n');
		process.exit(1);
	}
})();

// Tratamento de sinais para graceful shutdown
process.on('SIGINT', () => {
	console.log('Recebido SIGINT, encerrando consumers...');
	process.exit(0);
});

process.on('SIGTERM', () => {
	console.log('Recebido SIGTERM, encerrando consumers...');
	process.exit(0);
});
