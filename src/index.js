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

        // Statistiques de trading
        this.tradingStats = {
            startTime: new Date(),
            trades: {
                total: 0,
                successful: 0,
                failed: 0
            },
            profits: {
                totalWETH: 0,
                totalUSD: 0,
                bestTradeWETH: 0,
                bestTradeUSD: 0,
                worstTradeWETH: 0,
                worstTradeUSD: 0
            },
            volume: {
                totalWETH: 0,
                totalUSD: 0
            },
            gas: {
                totalGasUsed: 0,
                totalGasCostUSD: 0
            }
        };

        // Initialisation du bot Telegram
        if (process.env.ENABLE_TELEGRAM_ALERTS === 'true') {
            this.initializeTelegramBot();
        }

        // Initialisation du serveur Express
        this.initExpressServer();

        // Initialisation du récapitulatif périodique
        this.initializeRecap();
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

        // Exécution immédiate du premier monitoring
        this.monitorPools();

        // Configuration de l'intervalle à 30 secondes
        this.monitoringInterval = setInterval(async () => {
            try {
                await this.monitorPools();
            } catch (error) {
                logger.error('Erreur critique:', error);
                this.sendAlert(`🚨 Erreur critique: ${error.message}`);
            }
        }, 30000); // 30 secondes

        logger.info('🔄 Monitoring démarré (intervalle: 30 secondes)');
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
            logger.info(`⏱️ Timestamp: ${new Date().toISOString()}`);
            
            // Récupération des pools
            logger.info('📊 Tentative de récupération des pools...');
            const polWethPool = await this.getPool(this.POL, this.WETH);
            const polUsdcPool = await this.getPool(this.POL, this.USDC);
            
            if (!polWethPool || !polUsdcPool) {
                logger.error('❌ Pools non trouvés', {
                    polWethPool: !!polWethPool,
                    polUsdcPool: !!polUsdcPool
                });
                return;
            }
            logger.info('✅ Pools récupérés avec succès');

            // Récupération des prix en WETH et USDC
            logger.info('💹 Récupération des prix...');
            const polWethPrice = await this.getPrice(polWethPool);
            const polUsdcPrice = await this.getPrice(polUsdcPool);
            
            // Conversion du prix USDC en équivalent WETH pour comparaison
            const wethPriceInUsdc = 4.47; // Prix actuel de WETH en USDC
            const polUsdcPriceInWeth = polUsdcPrice / wethPriceInUsdc;

            // Calcul de la différence de prix
            const priceDifference = Math.abs(polWethPrice - polUsdcPriceInWeth);
            const priceDifferencePercent = (priceDifference / Math.min(polWethPrice, polUsdcPriceInWeth)) * 100;
            
            // Calcul de la taille du trade
            const tradeSize = Math.min(
                parseFloat(await this.getTokenBalance(this.WETH)),
                parseFloat(process.env.MAX_TRADE_SIZE_ETH || '0.05')
            );

            // Vérification du prix du gas
            const gasPrice = await this.provider.getGasPrice();
            const gasPriceGwei = ethers.utils.formatUnits(gasPrice, 'gwei');
            const maxGasPrice = parseFloat(process.env.MAX_GAS_PRICE_GWEI || '50');

            logger.info('⛽ Analyse du gas:', {
                currentGasPrice: `${gasPriceGwei} Gwei`,
                maxGasPrice: `${maxGasPrice} Gwei`,
                estimatedGasCost: `${(parseFloat(gasPriceGwei) * 250000 / 1e9).toFixed(6)} ETH`
            });

            // Exécution du trade si le prix du gas est acceptable
            if (parseFloat(gasPriceGwei) <= maxGasPrice) {
                logger.info('🚀 Tentative de trade...');
                
                try {
                    await this.executeArbitrage(polWethPool, polUsdcPool, polWethPrice, polUsdcPriceInWeth);
                    logger.info('✅ Trade exécuté avec succès');
                } catch (error) {
                    logger.error('❌ Erreur lors du trade:', {
                        message: error.message,
                        stack: error.stack,
                        timestamp: new Date().toISOString()
                    });
                    await this.sendAlert(`❌ Erreur lors du trade: ${error.message}`);
                }
            } else {
                logger.warn('⚠️ Prix du gas trop élevé pour trader');
            }

        } catch (error) {
            logger.error('❌ Erreur lors du monitoring:', {
                message: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            await this.sendAlert(`❌ Erreur lors du monitoring: ${error.message}`);
        }
    }

    async getTokenBalance(token) {
        try {
            const contract = new ethers.Contract(
                token.address,
                ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'],
                this.wallet
            );
            const [balance, decimals] = await Promise.all([
                contract.balanceOf(this.wallet.address),
                contract.decimals()
            ]);
            return ethers.utils.formatUnits(balance, decimals);
        } catch (error) {
            logger.error(`Erreur lors de la récupération du solde de ${token.symbol}:`, error);
            return '0';
        }
    }

    async executeArbitrage(polWethPool, polUsdcPool, polWethPrice, polUsdcPriceInWeth) {
        try {
            // Détermination de la direction de l'arbitrage
            const isWethToUsdc = polWethPrice > polUsdcPriceInWeth;
            
            // Log des balances initiales
            const initialBalances = {
                POL: await this.getTokenBalance(this.POL),
                WETH: await this.getTokenBalance(this.WETH),
                USDC: await this.getTokenBalance(this.USDC)
            };

            logger.info('💰 Balances initiales:', {
                POL: `${initialBalances.POL} POL`,
                WETH: `${initialBalances.WETH} WETH`,
                USDC: `${initialBalances.USDC} USDC`,
                totalValueUSD: `${(
                    parseFloat(initialBalances.WETH) * 4.47 +
                    parseFloat(initialBalances.USDC) +
                    parseFloat(initialBalances.POL) * parseFloat(polUsdcPrice)
                ).toFixed(2)} USD`
            });
            
            // Calcul de la taille optimale du trade
            const tradeSize = Math.min(
                parseFloat(initialBalances.WETH),
                parseFloat(process.env.MAX_TRADE_SIZE_ETH || '0.05')
            );

            if (tradeSize < 0.00001) {
                throw new Error(`Balance WETH insuffisante: ${tradeSize} WETH`);
            }

            logger.info('🔄 Préparation du trade:', {
                direction: isWethToUsdc ? 'WETH → POL → USDC' : 'POL → USDC → WETH',
                tradeSize: `${tradeSize} WETH`,
                tradeSizeUSD: `${(tradeSize * 4.47).toFixed(2)} USD`,
                prixPOLWETH: `${polWethPrice} WETH`,
                prixPOLUSDC: `${polUsdcPrice} USDC`,
                difference: `${((Math.abs(polWethPrice - polUsdcPriceInWeth) / Math.min(polWethPrice, polUsdcPriceInWeth)) * 100).toFixed(4)}%`,
                timestamp: new Date().toISOString()
            });

            // Premier swap
            const firstSwapAmount = ethers.utils.parseUnits(tradeSize.toString(), 18);
            logger.info('🔄 Exécution du premier swap:', {
                tokenIn: isWethToUsdc ? 'WETH' : 'POL',
                tokenOut: isWethToUsdc ? 'POL' : 'USDC',
                montant: ethers.utils.formatUnits(firstSwapAmount, 18),
                timestamp: new Date().toISOString()
            });

            const firstSwapResult = await this.executeSwap(
                isWethToUsdc ? this.WETH : this.POL,
                isWethToUsdc ? this.POL : this.USDC,
                firstSwapAmount
            );

            if (!firstSwapResult.success) {
                throw new Error(`Premier swap échoué: ${firstSwapResult.error}`);
            }

            // Log des balances intermédiaires
            const intermediateBalances = {
                POL: await this.getTokenBalance(this.POL),
                WETH: await this.getTokenBalance(this.WETH),
                USDC: await this.getTokenBalance(this.USDC)
            };

            logger.info('💰 Balances après premier swap:', {
                POL: `${intermediateBalances.POL} POL (Δ: ${(parseFloat(intermediateBalances.POL) - parseFloat(initialBalances.POL)).toFixed(6)})`,
                WETH: `${intermediateBalances.WETH} WETH (Δ: ${(parseFloat(intermediateBalances.WETH) - parseFloat(initialBalances.WETH)).toFixed(6)})`,
                USDC: `${intermediateBalances.USDC} USDC (Δ: ${(parseFloat(intermediateBalances.USDC) - parseFloat(initialBalances.USDC)).toFixed(6)})`
            });

            // Deuxième swap
            const secondSwapAmount = firstSwapResult.amountOut;
            logger.info('🔄 Exécution du deuxième swap:', {
                tokenIn: isWethToUsdc ? 'POL' : 'USDC',
                tokenOut: isWethToUsdc ? 'USDC' : 'WETH',
                montant: secondSwapAmount,
                timestamp: new Date().toISOString()
            });

            const secondSwapResult = await this.executeSwap(
                isWethToUsdc ? this.POL : this.USDC,
                isWethToUsdc ? this.USDC : this.WETH,
                secondSwapAmount
            );

            if (!secondSwapResult.success) {
                throw new Error(`Deuxième swap échoué: ${secondSwapResult.error}`);
            }

            // Log des balances finales
            const finalBalances = {
                POL: await this.getTokenBalance(this.POL),
                WETH: await this.getTokenBalance(this.WETH),
                USDC: await this.getTokenBalance(this.USDC)
            };

            logger.info('💰 Balances finales:', {
                POL: `${finalBalances.POL} POL (Δ: ${(parseFloat(finalBalances.POL) - parseFloat(initialBalances.POL)).toFixed(6)})`,
                WETH: `${finalBalances.WETH} WETH (Δ: ${(parseFloat(finalBalances.WETH) - parseFloat(initialBalances.WETH)).toFixed(6)})`,
                USDC: `${finalBalances.USDC} USDC (Δ: ${(parseFloat(finalBalances.USDC) - parseFloat(initialBalances.USDC)).toFixed(6)})`,
                totalValueUSD: `${(
                    parseFloat(finalBalances.WETH) * 4.47 +
                    parseFloat(finalBalances.USDC) +
                    parseFloat(finalBalances.POL) * parseFloat(polUsdcPrice)
                ).toFixed(2)} USD`
            });

            // Calcul du profit/perte
            const profit = parseFloat(finalBalances.WETH) - parseFloat(initialBalances.WETH);
            const profitUsd = profit * 4.47;

            logger.info('📊 Résultat du trade:', {
                profitWETH: `${profit.toFixed(6)} WETH`,
                profitUSD: `${profitUsd.toFixed(2)} USD`,
                profitPercent: `${((profit / parseFloat(initialBalances.WETH)) * 100).toFixed(4)}%`,
                gasUtilisé: `${(
                    parseFloat(firstSwapResult.gasUsed || 0) +
                    parseFloat(secondSwapResult.gasUsed || 0)
                ).toFixed(0)} gas`,
                coûtGasUSD: `${(
                    (parseFloat(firstSwapResult.gasUsed || 0) +
                    parseFloat(secondSwapResult.gasUsed || 0)) *
                    parseFloat(ethers.utils.formatUnits(await this.provider.getGasPrice(), 'gwei')) *
                    4.47 / 1e9
                ).toFixed(4)} USD`
            });

            // Mise à jour des métriques
            this.metrics.totalTrades.inc();
            
            // Mise à jour des statistiques
            this.tradingStats.trades.total++;
            this.tradingStats.volume.totalWETH += tradeSize;
            this.tradingStats.volume.totalUSD += tradeSize * 4.47;
            
            const gasUsed = parseFloat(firstSwapResult.gasUsed || 0) + parseFloat(secondSwapResult.gasUsed || 0);
            const gasCostUSD = gasUsed * parseFloat(ethers.utils.formatUnits(await this.provider.getGasPrice(), 'gwei')) * 4.47 / 1e9;
            
            this.tradingStats.gas.totalGasUsed += gasUsed;
            this.tradingStats.gas.totalGasCostUSD += gasCostUSD;

            if (profit >= 0) {
                this.metrics.successfulTrades.inc();
                this.metrics.dailyProfit.inc(profitUsd);
                this.tradingStats.trades.successful++;
                this.tradingStats.profits.totalWETH += profit;
                this.tradingStats.profits.totalUSD += profitUsd;
                
                if (profit > this.tradingStats.profits.bestTradeWETH) {
                    this.tradingStats.profits.bestTradeWETH = profit;
                    this.tradingStats.profits.bestTradeUSD = profitUsd;
                }
                
                await this.sendAlert(`🎉 Trade réussi!\nProfit: ${profit.toFixed(6)} WETH (${profitUsd.toFixed(2)} USD)\nGas utilisé: ${(
                    parseFloat(firstSwapResult.gasUsed || 0) +
                    parseFloat(secondSwapResult.gasUsed || 0)
                ).toFixed(0)}`);
            } else {
                this.metrics.failedTrades.inc();
                this.metrics.dailyLoss.inc(Math.abs(profitUsd));
                this.tradingStats.trades.failed++;
                this.tradingStats.profits.totalWETH += profit;
                this.tradingStats.profits.totalUSD += profitUsd;
                
                if (profit < this.tradingStats.profits.worstTradeWETH) {
                    this.tradingStats.profits.worstTradeWETH = profit;
                    this.tradingStats.profits.worstTradeUSD = profitUsd;
                }
                
                // Arrêt du bot en cas de perte
                logger.warn('🛑 Arrêt du bot suite à une perte');
                this.stopMonitoring();
                await this.sendAlert(`⚠️ Trade terminé avec perte\nPerte: ${Math.abs(profit).toFixed(6)} WETH (${Math.abs(profitUsd).toFixed(2)} USD)`);
            }
            
        } catch (error) {
            logger.error('❌ Erreur lors du trade:', {
                message: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    async executeSwap(tokenIn, tokenOut, amount) {
        try {
            logger.info('🔄 Préparation du swap:', {
                tokenIn: tokenIn.symbol,
                tokenOut: tokenOut.symbol,
                amount: ethers.utils.formatUnits(amount, tokenIn.decimals),
                timestamp: new Date().toISOString()
            });
            
            // Préparation de la transaction
            const router = new ethers.Contract(
                process.env.QUICKSWAP_ROUTER_ADDRESS,
                ['function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'],
                this.wallet
            );

            // Calcul du montant minimum de sortie avec slippage
            const amountOutMin = amount.mul(95).div(100); // 5% de slippage
            logger.info('📊 Paramètres du swap:', {
                amountIn: ethers.utils.formatUnits(amount, tokenIn.decimals),
                amountOutMin: ethers.utils.formatUnits(amountOutMin, tokenOut.decimals),
                slippage: '5%',
                path: [tokenIn.address, tokenOut.address],
                deadline: new Date(deadline * 1000).toISOString()
            });

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
            
            return { success: true, tx: receipt, amountOut: ethers.utils.formatUnits(receipt.logs[receipt.logs.length - 1].topics[3], 18) };

        } catch (error) {
            logger.error(`❌ Erreur swap ${tokenIn.symbol} -> ${tokenOut.symbol}:`, {
                message: error.message,
                stack: error.stack,
                tokenIn: tokenIn.symbol,
                tokenOut: tokenOut.symbol,
                amount: ethers.utils.formatUnits(amount, tokenIn.decimals),
                timestamp: new Date().toISOString()
            });
            return { success: false, error: error.message };
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

    initializeRecap() {
        // Récapitulatif toutes les 30 minutes
        setInterval(() => {
            this.sendTradingRecap();
        }, 30 * 60 * 1000); // 30 minutes
    }

    async sendTradingRecap() {
        const now = new Date();
        const duration = Math.floor((now - this.tradingStats.startTime) / 1000 / 60); // en minutes

        const recap = `📊 Récapitulatif des trades (${duration} minutes)\n\n` +
            `🔄 Trades totaux: ${this.tradingStats.trades.total}\n` +
            `✅ Trades réussis: ${this.tradingStats.trades.successful}\n` +
            `❌ Trades échoués: ${this.tradingStats.trades.failed}\n\n` +
            `💰 Profits:\n` +
            `- Total: ${this.tradingStats.profits.totalWETH.toFixed(6)} WETH (${this.tradingStats.profits.totalUSD.toFixed(2)} USD)\n` +
            `- Meilleur trade: ${this.tradingStats.profits.bestTradeWETH.toFixed(6)} WETH (${this.tradingStats.profits.bestTradeUSD.toFixed(2)} USD)\n` +
            `- Pire trade: ${this.tradingStats.profits.worstTradeWETH.toFixed(6)} WETH (${this.tradingStats.profits.worstTradeUSD.toFixed(2)} USD)\n\n` +
            `📈 Volume:\n` +
            `- Total: ${this.tradingStats.volume.totalWETH.toFixed(6)} WETH (${this.tradingStats.volume.totalUSD.toFixed(2)} USD)\n` +
            `- Moyenne par trade: ${(this.tradingStats.volume.totalWETH / (this.tradingStats.trades.total || 1)).toFixed(6)} WETH\n\n` +
            `⛽ Gas:\n` +
            `- Total utilisé: ${this.tradingStats.gas.totalGasUsed.toFixed(0)}\n` +
            `- Coût total: ${this.tradingStats.gas.totalGasCostUSD.toFixed(4)} USD\n` +
            `- Moyenne par trade: ${(this.tradingStats.gas.totalGasCostUSD / (this.tradingStats.trades.total || 1)).toFixed(4)} USD\n\n` +
            `📈 Performance:\n` +
            `- Taux de réussite: ${((this.tradingStats.trades.successful / (this.tradingStats.trades.total || 1)) * 100).toFixed(2)}%\n` +
            `- Profit moyen par trade: ${(this.tradingStats.profits.totalWETH / (this.tradingStats.trades.total || 1)).toFixed(6)} WETH\n` +
            `- ROI: ${((this.tradingStats.profits.totalUSD / (this.tradingStats.gas.totalGasCostUSD || 1)) * 100).toFixed(2)}%`;

        await this.sendAlert(recap);
        logger.info('📊 Récapitulatif des trades envoyé');
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