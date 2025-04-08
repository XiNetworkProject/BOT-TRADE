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
            this.initializeTelegramBot();
        }

        // Initialisation du serveur Express
        this.initExpressServer();
    }

    initExpressServer() {
        const app = express();
        const port = process.env.PORT || 10000;

        // Middleware
        app.use(cors());
        app.use(helmet());
        app.use(compression());
        app.use(express.json());

        // Route pour le webhook Telegram
        if (this.telegramBot) {
            app.post('/webhook', (req, res) => {
                this.telegramBot.handleUpdate(req.body);
                res.sendStatus(200);
            });
        }

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
            logger.info('🔍 Début du monitoring des pools...');
            
            // Récupération des pools
            const polWethPool = await this.getPool(this.POL, this.WETH);
            const polUsdcPool = await this.getPool(this.POL, this.USDC);
            
            if (!polWethPool || !polUsdcPool) {
                logger.error('❌ Pools non trouvés');
                return;
            }

            // Récupération des prix en WETH et USDC
            const polWethPrice = await this.getPrice(polWethPool);
            const polUsdcPrice = await this.getPrice(polUsdcPool);
            
            // Conversion du prix USDC en équivalent WETH pour comparaison
            const wethPriceInUsdc = 4.47; // Prix actuel de WETH en USDC
            const polUsdcPriceInWeth = polUsdcPrice / wethPriceInUsdc;

            logger.info('💰 Prix actuels:');
            logger.info(`- POL/WETH: ${polWethPrice} WETH`);
            logger.info(`- POL/USDC: ${polUsdcPrice} USDC (${polUsdcPriceInWeth} WETH)`);

            // Calcul de la différence de prix
            const priceDifference = Math.abs(polWethPrice - polUsdcPriceInWeth);
            const priceDifferencePercent = (priceDifference / Math.min(polWethPrice, polUsdcPriceInWeth)) * 100;
            
            logger.info(`📊 Différence de prix: ${priceDifferencePercent.toFixed(2)}%`);

            // Définition d'un seuil de profit minimum (0.5%)
            const minProfitThreshold = 0.5;

            // Vérification des opportunités d'arbitrage
            if (priceDifferencePercent >= minProfitThreshold) {
                const message = `🚨 Opportunité d'arbitrage détectée!\n` +
                               `Différence de prix: ${priceDifferencePercent.toFixed(2)}%\n` +
                               `Prix POL/WETH: ${polWethPrice} WETH\n` +
                               `Prix POL/USDC: ${polUsdcPrice} USDC (${polUsdcPriceInWeth} WETH)\n` +
                               `Seuil minimum: ${minProfitThreshold}%`;
                
                logger.info(message);
                await this.sendAlert(message);
                
                // Tentative d'exécution de l'arbitrage
                try {
                    await this.executeArbitrage(polWethPool, polUsdcPool, polWethPrice, polUsdcPriceInWeth);
                } catch (error) {
                    logger.error('❌ Erreur lors de l\'exécution de l\'arbitrage:', error);
                    await this.sendAlert(`❌ Erreur lors de l\'exécution de l\'arbitrage: ${error.message}`);
                }
            } else {
                logger.info(`⏳ Différence de prix (${priceDifferencePercent.toFixed(2)}%) inférieure au seuil minimum (${minProfitThreshold}%)`);
            }

            // Vérification de la liquidité
            const polWethLiquidity = await this.getPoolLiquidity(polWethPool);
            const polUsdcLiquidity = await this.getPoolLiquidity(polUsdcPool);
            
            logger.info('💧 Liquidité des pools:');
            logger.info(`- POL/WETH: ${polWethLiquidity} WETH`);
            logger.info(`- POL/USDC: ${polUsdcLiquidity} USDC`);

        } catch (error) {
            logger.error('❌ Erreur lors du monitoring des pools:', error);
            await this.sendAlert(`❌ Erreur lors du monitoring des pools: ${error.message}`);
        }
    }

    async getPoolLiquidity(pool) {
        try {
            const reserves = await pool.getReserves();
            const token0 = await pool.token0();
            const isWethToken0 = token0.toLowerCase() === this.WETH.address.toLowerCase();
            
            const wethReserve = isWethToken0 ? reserves[0] : reserves[1];
            return ethers.utils.formatEther(wethReserve);
        } catch (error) {
            logger.error('Erreur lors de la récupération de la liquidité:', error);
            return '0';
        }
    }

    async executeArbitrage(polWethPool, polUsdcPool, polWethPrice, polUsdcPriceInWeth) {
        try {
            logger.info('🔄 Début de l\'exécution de l\'arbitrage...');
            
            // Vérification des soldes de tous les tokens
            const polContract = new ethers.Contract(
                this.POL.address,
                ['function balanceOf(address) view returns (uint256)'],
                this.wallet
            );
            const wethContract = new ethers.Contract(
                this.WETH.address,
                ['function balanceOf(address) view returns (uint256)'],
                this.wallet
            );
            const usdcContract = new ethers.Contract(
                this.USDC.address,
                ['function balanceOf(address) view returns (uint256)'],
                this.wallet
            );

            const [polBalance, wethBalance, usdcBalance] = await Promise.all([
                polContract.balanceOf(this.wallet.address),
                wethContract.balanceOf(this.wallet.address),
                usdcContract.balanceOf(this.wallet.address)
            ]);

            logger.info('💰 Soldes actuels:');
            logger.info(`- POL: ${ethers.utils.formatUnits(polBalance, 18)} POL`);
            logger.info(`- WETH: ${ethers.utils.formatUnits(wethBalance, 18)} WETH`);
            logger.info(`- USDC: ${ethers.utils.formatUnits(usdcBalance, 6)} USDC`);

            // Détermination du token source en fonction des prix
            let sourceToken, sourceBalance, targetToken;
            if (polWethPrice > polUsdcPriceInWeth) {
                // Si POL/WETH est plus cher que POL/USDC, on commence par USDC
                sourceToken = this.USDC;
                sourceBalance = usdcBalance;
                targetToken = this.WETH;
                logger.info('📈 Stratégie: USDC -> WETH -> POL');
            } else {
                // Sinon, on commence par POL
                sourceToken = this.POL;
                sourceBalance = polBalance;
                targetToken = this.WETH;
                logger.info('📈 Stratégie: POL -> WETH -> USDC');
            }

            // Vérification du solde suffisant
            if (sourceBalance.eq(0)) {
                const message = `❌ Solde insuffisant en ${sourceToken.symbol}`;
                logger.warn(message);
                await this.sendAlert(message);
                return;
            }

            // Calcul du montant du swap (0.5% du solde du token source)
            const swapAmount = sourceBalance.mul(5).div(1000);
            logger.info(`💱 Montant du swap: ${ethers.utils.formatUnits(swapAmount, sourceToken.decimals)} ${sourceToken.symbol}`);

            // Vérification de l'approbation
            const sourceTokenContract = new ethers.Contract(
                sourceToken.address,
                ['function approve(address spender, uint256 amount) returns (bool)'],
                this.wallet
            );

            logger.info(`🔓 Approbation du contrat router pour ${sourceToken.symbol}...`);
            const approveTx = await sourceTokenContract.approve(
                process.env.QUICKSWAP_ROUTER_ADDRESS,
                swapAmount
            );
            await approveTx.wait();
            logger.info('✅ Approbation confirmée');

            // Exécution des swaps
            if (polWethPrice > polUsdcPriceInWeth) {
                await this.executeSwap(this.USDC, this.WETH, swapAmount);
                const wethReceived = await wethContract.balanceOf(this.wallet.address);
                await this.executeSwap(this.WETH, this.POL, wethReceived);
            } else {
                await this.executeSwap(this.POL, this.WETH, swapAmount);
                const wethReceived = await wethContract.balanceOf(this.wallet.address);
                await this.executeSwap(this.WETH, this.USDC, wethReceived);
            }

            const profitMessage = `✅ Arbitrage réussi!\n` +
                                `Direction: ${polWethPrice > polUsdcPriceInWeth ? 'USDC->WETH->POL' : 'POL->WETH->USDC'}\n` +
                                `Montant: ${ethers.utils.formatUnits(swapAmount, sourceToken.decimals)} ${sourceToken.symbol}`;
            
            logger.info(profitMessage);
            await this.sendAlert(profitMessage);

        } catch (error) {
            logger.error('❌ Erreur lors de l\'exécution de l\'arbitrage:', error);
            throw error;
        }
    }

    async executeSwap(tokenIn, tokenOut, amount) {
        try {
            logger.info(`🔄 Début du swap ${tokenIn.symbol} -> ${tokenOut.symbol}`);
            
            // Préparation de la transaction
            const router = new ethers.Contract(
                process.env.QUICKSWAP_ROUTER_ADDRESS,
                ['function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'],
                this.wallet
            );

            // Calcul du montant minimum de sortie avec slippage
            const amountOutMin = amount.mul(95).div(100); // 5% de slippage
            logger.info(`📊 Montant minimum attendu: ${ethers.utils.formatEther(amountOutMin)} ${tokenOut.symbol}`);

            // Préparation du chemin de swap
            const path = [tokenIn.address, tokenOut.address];
            const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

            // Exécution du swap
            logger.info('⏳ Envoi de la transaction...');
            const tx = await router.swapExactTokensForTokens(
                amount,
                amountOutMin,
                path,
                this.wallet.address,
                deadline
            );

            // Attente de la confirmation
            logger.info('⏳ Attente de la confirmation...');
            const receipt = await tx.wait();
            
            logger.info(`✅ Swap ${tokenIn.symbol} -> ${tokenOut.symbol} confirmé!`);
            logger.info(`📝 Hash de la transaction: ${receipt.transactionHash}`);
            
            return receipt;

        } catch (error) {
            logger.error(`❌ Erreur lors du swap ${tokenIn.symbol} -> ${tokenOut.symbol}:`, error);
            throw error;
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

        logger.info('Vérification opportunité d\'arbitrage:', {
            priceDifference,
            minProfitThreshold,
            dailyLoss: this.metrics.dailyLoss.get()
        });

        if (priceDifference > minProfitThreshold) {
            logger.info(`Opportunité d'arbitrage détectée! Différence de prix: ${priceDifference}%`);
            
            if (this.metrics.dailyLoss.get() >= parseFloat(process.env.MAX_DAILY_LOSS_PERCENT)) {
                logger.warn('Limite de perte quotidienne atteinte');
                this.sendAlert('⚠️ Limite de perte quotidienne atteinte!');
                return;
            }

            await this.executeTrade(price1, price2);
        } else {
            logger.info('Pas d\'opportunité d\'arbitrage détectée');
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

    async initializeTelegramBot() {
        try {
            // Vérification du token
            if (!process.env.TELEGRAM_BOT_TOKEN) {
                logger.error('Token Telegram non configuré');
                return;
            }

            logger.info('Initialisation du bot Telegram...');
            
            // Arrêt de toute instance existante
            if (this.telegramBot) {
                logger.info('Arrêt de l\'instance existante du bot Telegram...');
                try {
                    await this.telegramBot.stopPolling();
                    await this.telegramBot.close();
                } catch (error) {
                    logger.warn('Erreur lors de l\'arrêt du bot existant:', error);
                }
                this.telegramBot = null;
            }

            // Attente de 10 secondes pour s'assurer que l'ancienne instance est bien arrêtée
            logger.info('Attente de 10 secondes pour s\'assurer que l\'ancienne instance est bien arrêtée...');
            await new Promise(resolve => setTimeout(resolve, 10000));

            // Vérification de l'état du bot via l'API Telegram
            try {
                const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`);
                const data = await response.json();
                if (!data.ok) {
                    logger.error('Erreur lors de la vérification du bot:', data);
                    throw new Error('Impossible de vérifier l\'état du bot');
                }
                logger.info('État du bot vérifié avec succès');
            } catch (error) {
                logger.error('Erreur lors de la vérification de l\'état du bot:', error);
                throw error;
            }

            // Création d'une nouvelle instance avec des paramètres optimisés
            this.telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
                polling: {
                    interval: 300,
                    autoStart: false,
                    params: {
                        timeout: 10,
                        allowed_updates: ['message', 'callback_query']
                    }
                }
            });

            // Gestion des erreurs de polling
            this.telegramBot.on('polling_error', async (error) => {
                logger.error('Erreur de polling Telegram:', error);
                
                if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
                    logger.warn('Conflit détecté avec une autre instance du bot Telegram');
                    
                    // Arrêt complet du bot
                    try {
                        await this.telegramBot.stopPolling();
                        await this.telegramBot.close();
                    } catch (stopError) {
                        logger.warn('Erreur lors de l\'arrêt du bot:', stopError);
                    }
                    this.telegramBot = null;
                    
                    // Attente plus longue avant de réessayer
                    setTimeout(() => {
                        logger.info('Tentative de réinitialisation du bot Telegram...');
                        this.initializeTelegramBot();
                    }, 60000); // 60 secondes
                }
            });

            // Vérification de la connexion
            const botInfo = await this.telegramBot.getMe();
            logger.info(`Bot Telegram connecté: ${botInfo.username}`);
            
            // Démarrage du polling
            await this.telegramBot.startPolling();
            logger.info('Polling démarré avec succès');
            
            // Envoi d'un message de test
            await this.sendAlert('🤖 Bot d\'arbitrage connecté et prêt!');

        } catch (error) {
            logger.error('Erreur lors de l\'initialisation du bot Telegram:', error);
            this.telegramBot = null;
            
            // Tentative de réinitialisation après un délai
            setTimeout(() => {
                logger.info('Tentative de réinitialisation du bot Telegram après erreur...');
                this.initializeTelegramBot();
            }, 60000);
        }
    }

    async start() {
        try {
            console.log('🚀 Démarrage du bot d\'arbitrage...');
            
            // Vérification de la connexion au réseau
            const network = await this.provider.getNetwork();
            console.log(`🌐 Connecté au réseau: ${network.name} (Chain ID: ${network.chainId})`);
            
            // Vérification du solde du portefeuille
            const balance = await this.wallet.getBalance();
            const balanceInEth = ethers.utils.formatEther(balance);
            console.log(`💰 Solde du portefeuille: ${balanceInEth} ETH`);
            
            if (parseFloat(balanceInEth) < 0.00001) {
                console.warn('⚠️ Attention: Solde insuffisant pour effectuer des transactions');
                this.sendAlert('⚠️ Attention: Solde insuffisant pour effectuer des transactions');
            }
            
            // Vérification des pools
            console.log('🔍 Vérification des pools...');
            const polWethPool = await this.getPoolWithCache(this.POL, this.WETH);
            const polUsdcPool = await this.getPoolWithCache(this.POL, this.USDC);
            
            if (!polWethPool || !polUsdcPool) {
                throw new Error('Un ou plusieurs pools non trouvés');
            }
            
            console.log('✅ Pools vérifiés avec succès');
            
            // Initialisation du bot Telegram si activé
            if (process.env.ENABLE_TELEGRAM_ALERTS === 'true') {
                console.log('🤖 Initialisation du bot Telegram...');
                this.initializeTelegramBot();
            }
            
            // Démarrage du monitoring
            this.startMonitoring();
            console.log(`⏱️ Monitoring démarré (fréquence: ${process.env.TRADE_FREQUENCY_MS}ms)`);
            
        } catch (error) {
            console.error('❌ Erreur critique lors du démarrage:', error);
            this.sendAlert(`❌ Erreur au démarrage: ${error.message}`);
            process.exit(1);
        }
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