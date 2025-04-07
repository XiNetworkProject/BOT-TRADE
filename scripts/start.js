const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Vérification des variables d'environnement requises
const requiredEnvVars = [
    'POLYGON_RPC_URL',
    'PRIVATE_KEY',
    'POL_TOKEN_ADDRESS',
    'WETH_TOKEN_ADDRESS',
    'USDC_TOKEN_ADDRESS'
];

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
if (missingEnvVars.length > 0) {
    console.error('❌ Variables d\'environnement manquantes:', missingEnvVars.join(', '));
    process.exit(1);
}

// Configuration du processus
process.on('uncaughtException', (error) => {
    console.error('❌ Erreur non gérée:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promesse rejetée non gérée:', reason);
    process.exit(1);
});

// Démarrage du bot
console.log('🚀 Démarrage du bot d\'arbitrage...');
require('../src/index.js'); 