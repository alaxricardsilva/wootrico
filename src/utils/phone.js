'use strict';

// Códigos de país comuns (pode ser expandido)
const COUNTRY_CODES = {
	'BR': '55', // Brasil
	'US': '1',  // Estados Unidos
	'CA': '1',  // Canadá
	'MX': '52', // México
	'AR': '54', // Argentina
	'CL': '56', // Chile
	'CO': '57', // Colômbia
	'PE': '51', // Peru
	'VE': '58', // Venezuela
	'UY': '598', // Uruguai
	'PY': '595', // Paraguai
	'BO': '591', // Bolívia
	'EC': '593', // Equador
	'GY': '592', // Guiana
	'SR': '597', // Suriname
	'PT': '351', // Portugal
	'ES': '34',  // Espanha
	'FR': '33',  // França
	'DE': '49',  // Alemanha
	'IT': '39',  // Itália
	'GB': '44',  // Reino Unido
	'AU': '61',  // Austrália
	'NZ': '64',  // Nova Zelândia
	'JP': '81',  // Japão
	'CN': '86',  // China
	'IN': '91',  // Índia
	'RU': '7',   // Rússia
	'ZA': '27',  // África do Sul
	'EG': '20',  // Egito
	'NG': '234', // Nigéria
	'KE': '254', // Quênia
	'MA': '212', // Marrocos
	'DZ': '213', // Argélia
	'TN': '216', // Tunísia
	'LY': '218', // Líbia
	'SD': '249', // Sudão
	'ET': '251', // Etiópia
	'SO': '252', // Somália
	'DJ': '253', // Djibouti
	'SS': '211', // Sudão do Sul
	'CF': '236', // República Centro-Africana
	'CM': '237', // Camarões
	'TD': '235', // Chade
	'GA': '241', // Gabão
	'CG': '242', // República do Congo
	'CD': '243', // República Democrática do Congo
	'AO': '244', // Angola
	'GW': '245', // Guiné-Bissau
	'IO': '246', // Território Britânico do Oceano Índico
	'AC': '247', // Ilha de Ascensão
	'SC': '248', // Seychelles
	'ST': '250', // São Tomé e Príncipe
	'GQ': '240', // Guiné Equatorial
	'GM': '220', // Gâmbia
	'GN': '224', // Guiné
	'SL': '232', // Serra Leoa
	'LR': '231', // Libéria
	'CI': '225', // Costa do Marfim
	'GH': '233', // Gana
	'TG': '228', // Togo
	'BJ': '229', // Benim
	'BF': '226', // Burkina Faso
	'ML': '223', // Mali
	'NE': '227', // Níger
	'SN': '221', // Senegal
	'MR': '222', // Mauritânia
	'CV': '238', // Cabo Verde	
};

/**
 * Normaliza um número de telefone para o padrão E.164
 * @param {string} phone - Número de telefone em qualquer formato
 * @param {string} defaultCountry - Código do país padrão (ex: 'BR', 'US')
 * @returns {string} - Número no padrão E.164 (+[código do país][número])
 */
function normalizeToE164(phone, defaultCountry = 'BR') {
	if (!phone) return null;
	
	// Remove todos os caracteres não numéricos
	const cleanPhone = phone.replace(/\D/g, '');
	
	// Se já começa com +, já está no formato E.164
	if (phone.startsWith('+')) {
		return phone;
	}
	
	// Se já começa com 00, remove e adiciona +
	if (cleanPhone.startsWith('00')) {
		return `+${cleanPhone.slice(2)}`;
	}
	
	// Se já começa com código de país conhecido, adiciona +
	for (const [country, code] of Object.entries(COUNTRY_CODES)) {
		if (cleanPhone.startsWith(code)) {
			return `+${cleanPhone}`;
		}
	}
	
	// Se não tem código de país, adiciona o padrão
	const defaultCode = COUNTRY_CODES[defaultCountry.toUpperCase()];
	if (defaultCode) {
		return `+${defaultCode}${cleanPhone}`;
	}
	
	// Se não conseguiu identificar, retorna como está com +
	console.warn(`Código de país não reconhecido para: ${phone}, usando formato genérico`);
	return `+${cleanPhone}`;
}

/**
 * Detecta o código do país de um número de telefone
 * @param {string} phone - Número de telefone
 * @returns {string|null} - Código do país ou null se não encontrado
 */
function detectCountryCode(phone) {
	if (!phone) return null;
	
	const cleanPhone = phone.replace(/\D/g, '');
	
	// Se já tem +, remove para análise
	const numberWithoutPlus = phone.startsWith('+') ? cleanPhone : cleanPhone;
	
	// Procura por códigos de país conhecidos
	for (const [country, code] of Object.entries(COUNTRY_CODES)) {
		if (numberWithoutPlus.startsWith(code)) {
			return country;
		}
	}
	
	return null;
}

/**
 * Valida se um número de telefone está no formato E.164
 * @param {string} phone - Número de telefone
 * @returns {boolean} - True se está no formato E.164
 */
function isValidE164(phone) {
	if (!phone) return false;
	
	// Padrão E.164: +[código do país][número]
	const e164Pattern = /^\+[1-9]\d{1,14}$/;
	return e164Pattern.test(phone);
}

/**
 * Extrai apenas os dígitos de um número de telefone
 * @param {string} phone - Número de telefone
 * @returns {string} - Apenas os dígitos
 */
function extractDigits(phone) {
	if (!phone) return '';
	return phone.replace(/\D/g, '');
}

/**
 * Formata um número de telefone para exibição
 * @param {string} phone - Número no formato E.164
 * @param {string} country - Código do país para formatação específica
 * @returns {string} - Número formatado para exibição
 */
function formatForDisplay(phone, country = 'BR') {
	if (!phone) return '';
	
	const digits = extractDigits(phone);
	
	// Remove o código do país se presente
	let nationalNumber = digits;
	for (const [countryCode, code] of Object.entries(COUNTRY_CODES)) {
		if (digits.startsWith(code)) {
			nationalNumber = digits.slice(code.length);
			break;
		}
	}
	
	// Formatação específica por país
	switch (country.toUpperCase()) {
	case 'BR':
		if (nationalNumber.length === 11) {
			return `(${nationalNumber.slice(0, 2)}) ${nationalNumber.slice(2, 7)}-${nationalNumber.slice(7)}`;
		}
		if (nationalNumber.length === 10) {
			return `(${nationalNumber.slice(0, 2)}) ${nationalNumber.slice(2, 6)}-${nationalNumber.slice(6)}`;
		}
		break;
	case 'US':
	case 'CA':
		if (nationalNumber.length === 10) {
			return `(${nationalNumber.slice(0, 3)}) ${nationalNumber.slice(3, 6)}-${nationalNumber.slice(6)}`;
		}
		break;
	case 'MX':
		if (nationalNumber.length === 10) {
			return `${nationalNumber.slice(0, 2)} ${nationalNumber.slice(2, 6)} ${nationalNumber.slice(6)}`;
		}
		break;
	case 'AR':
		if (nationalNumber.length === 10) {
			return `${nationalNumber.slice(0, 2)} ${nationalNumber.slice(2, 6)} ${nationalNumber.slice(6)}`;
		}
		break;
	}
	
	return phone; // Retorna como está se não conseguir formatar
}

/**
 * Obtém o código de país para um país específico
 * @param {string} country - Código do país (ex: 'BR', 'US')
 * @returns {string|null} - Código numérico do país
 */
function getCountryCode(country) {
	return COUNTRY_CODES[country.toUpperCase()] || null;
}

export { 
	normalizeToE164, 
	isValidE164, 
	extractDigits, 
	formatForDisplay, 
	detectCountryCode,
	getCountryCode,
	COUNTRY_CODES 
};
