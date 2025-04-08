require('dotenv').config();
const { ethers } = require('ethers');
const { Token, CurrencyAmount, TradeType } = require('@uniswap/sdk-core');
const { Pool, Route, Trade } = require('@uniswap/v3-sdk');
const TelegramBot = require('node-telegram-bot-api');
const NodeCache = require('node-cache');
const winston = require('winston');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const promClient = require('prom-client');

// Configuration du logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.simple()
        })
    ]
});

// Configuration des métriques Prometheus
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// Cache pour les données fréquemment utilisées
const cache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

// Rate limiter pour les appels API
const rateLimiter = new RateLimiterMemory({
    points: 10,
    duration: 1
});

class ArbitrageBot {
    constructor() {
        this.provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
        this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);
        
        // Vérification des adresses
        console.log('Vérification des adresses...');
        console.log('POL:', process.env.POL_TOKEN_ADDRESS);
        console.log('WETH:', process.env.WETH_TOKEN_ADDRESS);
        console.log('USDC:', process.env.USDC_TOKEN_ADDRESS);
        
        if (!ethers.utils.isAddress(process.env.POL_TOKEN_ADDRESS)) {
            throw new Error(`Adresse POL invalide: ${process.env.POL_TOKEN_ADDRESS}`);
        }
        if (!ethers.utils.isAddress(process.env.WETH_TOKEN_ADDRESS)) {
            throw new Error(`Adresse WETH invalide: ${process.env.WETH_TOKEN_ADDRESS}`);
        }
        if (!ethers.utils.isAddress(process.env.USDC_TOKEN_ADDRESS)) {
            throw new Error(`Adresse USDC invalide: ${process.env.USDC_TOKEN_ADDRESS}`);
        }
        
        // Initialisation des tokens
        this.POL = new Token(137, process.env.POL_TOKEN_ADDRESS, 18, 'POL', 'Polymath');
        this.WETH = new Token(137, process.env.WETH_TOKEN_ADDRESS, 18, 'WETH', 'Wrapped Ether');
        this.USDC = new Token(137, process.env.USDC_TOKEN_ADDRESS, 6, 'USDC', 'USD Coin');

        // Métriques
        this.metrics = {
            dailyProfit: new promClient.Gauge({ name: 'daily_profit', help: 'Profit quotidien en USD' }),
            dailyLoss: new promClient.Gauge({ name: 'daily_loss', help: 'Perte quotidienne en USD' }),
            totalTrades: new promClient.Counter({ name: 'total_trades', help: 'Nombre total de trades' }),
            successfulTrades: new promClient.Counter({ name: 'successful_trades', help: 'Nombre de trades réussis' }),
            failedTrades: new promClient.Counter({ name: 'failed_trades', help: 'Nombre de trades échoués' })
        };

        // Initialisation du bot Telegram
        if (process.env.ENABLE_TELEGRAM_ALERTS === 'true') {
            try {
                this.telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
                    polling: {
                        interval: 300,
                        autoStart: false
                    }
                });
                this.telegramBot.startPolling();
                logger.info('Bot Telegram initialisé avec succès');
            } catch (error) {
                logger.error('Erreur lors de l\'initialisation du bot Telegram:', error);
                this.telegramBot = null;
            }
        }

        // Initialisation du serveur Express
        this.initExpressServer();
    }

    initExpressServer() {
        const app = express();
        const port = process.env.PORT || 3000;

        app.use(helmet());
        app.use(cors());
        app.use(compression());

        // Endpoint de santé
        app.get('/health', (req, res) => {
            res.json({ status: 'healthy' });
        });

        // Endpoint pour les métriques Prometheus
        app.get('/metrics', async (req, res) => {
            res.set('Content-Type', register.contentType);
            res.end(await register.metrics());
        });

        // Endpoint pour les statistiques
        app.get('/stats', (req, res) => {
            res.json({
                dailyProfit: this.metrics.dailyProfit.get(),
                dailyLoss: this.metrics.dailyLoss.get(),
                totalTrades: this.metrics.totalTrades.get(),
                successfulTrades: this.metrics.successfulTrades.get(),
                failedTrades: this.metrics.failedTrades.get()
            });
        });

        // Endpoint pour démarrer/arrêter le bot
        app.post('/control', (req, res) => {
            const { action } = req.body;
            if (action === 'start' && !this.monitoringInterval) {
                this.startMonitoring();
                res.json({ status: 'started' });
            } else if (action === 'stop' && this.monitoringInterval) {
                this.stopMonitoring();
                res.json({ status: 'stopped' });
            } else {
                res.status(400).json({ error: 'Action invalide ou déjà en cours' });
            }
        });

        app.listen(port, () => {
            logger.info(`Serveur démarré sur le port ${port}`);
        });
    }

    startMonitoring() {
        if (this.monitoringInterval) {
            logger.warn('Le monitoring est déjà en cours');
            return;
        }

        this.monitoringInterval = setInterval(async () => {
            try {
                await this.monitorPools();
            } catch (error) {
                logger.error('Erreur critique:', error);
                this.sendAlert(`🚨 Erreur critique: ${error.message}`);
            }
        }, parseInt(process.env.TRADE_FREQUENCY_MS));

        logger.info('Monitoring démarré');
    }

    stopMonitoring() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
            logger.info('Monitoring arrêté');
        }
    }

    async monitorPools() {
        try {
            await rateLimiter.consume('monitor');
            
            const currentGasPrice = await this.getCurrentGasPrice();
            if (currentGasPrice > process.env.MAX_GAS_PRICE_GWEI) {
                logger.info('Prix du gas trop élevé, attente...');
                return;
            }

            logger.info('Surveillance des pools POL/WETH et POL/USDC...');
            
            const [polWethPool, polUsdcPool] = await Promise.all([
                this.getPoolWithCache(this.POL, this.WETH),
                this.getPoolWithCache(this.POL, this.USDC)
            ]);

            logger.info('Pools récupérées:', {
                polWethPool: polWethPool ? 'OK' : 'NON TROUVÉ',
                polUsdcPool: polUsdcPool ? 'OK' : 'NON TROUVÉ'
            });

            if (!await this.checkPoolLiquidity(polWethPool) || !await this.checkPoolLiquidity(polUsdcPool)) {
                logger.info('Liquidité insuffisante dans les pools');
                return;
            }

            const [polWethPrice, polUsdcPrice] = await Promise.all([
                this.getPriceWithCache(polWethPool),
                this.getPriceWithCache(polUsdcPool)
            ]);

            logger.info('Prix actuels:', {
                polWethPrice: polWethPrice,
                polUsdcPrice: polUsdcPrice,
                difference: Math.abs(polWethPrice - polUsdcPrice)
            });

            await this.checkArbitrageOpportunity(polWethPrice, polUsdcPrice);
        } catch (error) {
            logger.error('Erreur lors de la surveillance des pools:', error);
            this.sendAlert(`Erreur: ${error.message}`);
        }
    }

    async getPoolWithCache(tokenA, tokenB) {
        const cacheKey = `pool_${tokenA.address}_${tokenB.address}`;
        let pool = cache.get(cacheKey);

        if (!pool) {
            pool = await this.getPool(tokenA, tokenB);
            cache.set(cacheKey, pool);
        }

        return pool;
    }

    async getPriceWithCache(pool) {
        const cacheKey = `price_${pool.token0.address}_${pool.token1.address}`;
        let price = cache.get(cacheKey);

        if (!price) {
            price = await this.getPrice(pool);
            cache.set(cacheKey, price);
        }

        return price;
    }

    async checkArbitrageOpportunity(price1, price2) {
        const priceDifference = Math.abs(price1 - price2);
        const minProfitThreshold = parseFloat(process.env.MIN_PROFIT_THRESHOLD);

        if (priceDifference > minProfitThreshold) {
            logger.info(`Opportunité d'arbitrage détectée! Différence de prix: ${priceDifference}%`);
            
            if (this.metrics.dailyLoss.get() >= parseFloat(process.env.MAX_DAILY_LOSS_PERCENT)) {
                logger.warn('Limite de perte quotidienne atteinte');
                this.sendAlert('⚠️ Limite de perte quotidienne atteinte!');
                return;
            }

            await this.executeTrade(price1, price2);
        }
    }

    async executeTrade(price1, price2) {
        try {
            const maxTradeSize = ethers.utils.parseEther(process.env.MAX_TRADE_SIZE_ETH);
            const gasPrice = await this.getAdjustedGasPrice();

            const tradeSize = this.calculateOptimalTradeSize(price1, price2, maxTradeSize);
            const slippageTolerance = parseFloat(process.env.SLIPPAGE_TOLERANCE);
            const minAmountOut = tradeSize.mul(100 - slippageTolerance).div(100);

            // Simulation du trade avant exécution
            const simulatedProfit = await this.simulateTrade(tradeSize, price1, price2);
            if (simulatedProfit < parseFloat(process.env.MIN_PROFIT_THRESHOLD)) {
                logger.info('Profit simulé insuffisant, trade annulé');
                return;
            }

            // Exécution du trade
            const tx = await this.executeTradeOnChain(tradeSize, minAmountOut, gasPrice);
            
            this.metrics.totalTrades.inc();
            this.metrics.successfulTrades.inc();
            this.metrics.dailyProfit.inc(simulatedProfit);
            
            logger.info(`Trade réussi! TX: ${tx.hash}`);
            this.sendAlert(`✅ Trade réussi! Profit: ${simulatedProfit}%`);

        } catch (error) {
            logger.error('Erreur lors de l\'exécution du trade:', error);
            this.metrics.failedTrades.inc();
            this.metrics.dailyLoss.inc(parseFloat(process.env.MAX_SINGLE_TRADE_LOSS_PERCENT));
            this.sendAlert(`❌ Échec du trade: ${error.message}`);
        }
    }

    async simulateTrade(tradeSize, price1, price2) {
        // Simulation détaillée du trade avec prise en compte des frais
        const fees = await this.calculateFees(tradeSize);
        const potentialProfit = (price2 - price1) * 100;
        return potentialProfit - fees;
    }

    async calculateFees(tradeSize) {
        // Calcul des frais de trading et de gas
        const gasPrice = await this.getCurrentGasPrice();
        const gasLimit = 250000; // Estimation
        const gasCost = gasPrice * gasLimit;
        const tradingFees = tradeSize.mul(3).div(1000); // 0.3% de frais
        return gasCost + tradingFees;
    }

    calculateOptimalTradeSize(price1, price2, maxSize) {
        const priceDiff = Math.abs(price1 - price2);
        const optimalSize = maxSize.mul(priceDiff).div(100);
        return optimalSize.gt(maxSize) ? maxSize : optimalSize;
    }

    async getAdjustedGasPrice() {
        const currentGasPrice = await this.provider.getGasPrice();
        return currentGasPrice.mul(
            Math.floor(parseFloat(process.env.GAS_PRICE_MULTIPLIER) * 100)
        ).div(100);
    }

    sendAlert(message) {
        if (this.telegramBot && process.env.ENABLE_TELEGRAM_ALERTS === 'true') {
            this.telegramBot.sendMessage(process.env.TELEGRAM_CHAT_ID, message);
        }
        logger.info(message);
    }
}

// Création et démarrage du bot
const bot = new ArbitrageBot();

// Gestion propre de l'arrêt
process.on('SIGINT', () => {
    bot.stopMonitoring();
    logger.info('Bot arrêté proprement');
    process.exit();
}); 