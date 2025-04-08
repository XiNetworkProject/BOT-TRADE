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

        logger.info('🚀 Démarrage du monitoring...');
        
        // Exécution immédiate du premier monitoring
        this.monitorPools().catch(error => {
            logger.error('Erreur lors du premier monitoring:', error);
        });

        // Configuration de l'intervalle à 30 secondes
        this.monitoringInterval = setInterval(async () => {
            try {
                await this.monitorPools();
            } catch (error) {
                logger.error('Erreur lors du monitoring:', error);
            }
        }, 30000); // 30 secondes

        logger.info('⏱️ Monitoring configuré (intervalle: 30 secondes)');
        this.sendAlert('🔄 Monitoring démarré - Vérification toutes les 30 secondes');
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
            logger.info('🔍 Début du cycle de monitoring...');

            // Vérification de la connexion au réseau
            const network = await this.provider.getNetwork();
            logger.info('🌐 Réseau connecté:', {
                name: network.name,
                chainId: network.chainId
            });

            // Vérification du solde du wallet
            const balance = await this.provider.getBalance(this.wallet.address);
            const balanceEth = ethers.utils.formatEther(balance);
            logger.info('💰 Balance du wallet:', {
                address: this.wallet.address,
                balance: `${balanceEth} ETH`
            });

            if (parseFloat(balanceEth) < 0.00001) {
                logger.warn('⚠️ Balance trop faible pour trader');
                await this.sendAlert(`⚠️ Balance insuffisante: ${balanceEth} ETH`);
                return;
            }

            // Récupération des pools
            logger.info('🏊 Tentative de récupération des pools...');
            const polWethPool = await this.getPool(this.POL, this.WETH);
            const polUsdcPool = await this.getPool(this.POL, this.USDC);
            
            if (!polWethPool || !polUsdcPool) {
                logger.error('❌ Pools non trouvés', {
                    polWethPool: !!polWethPool,
                    polUsdcPool: !!polUsdcPool
                });
                return;
            }
            logger.info('✅ Pools trouvés');

            // Récupération des prix
            const polWethPrice = await this.getPrice(polWethPool);
            const polUsdcPrice = await this.getPrice(polUsdcPool);
            const wethPriceInUsdc = 4.47;
            const polUsdcPriceInWeth = polUsdcPrice / wethPriceInUsdc;

            logger.info('💹 Prix actuels:', {
                POL_WETH: `${polWethPrice} WETH`,
                POL_USDC: `${polUsdcPrice} USDC`,
                POL_USDC_IN_WETH: `${polUsdcPriceInWeth} WETH`,
                différence: `${((Math.abs(polWethPrice - polUsdcPriceInWeth) / Math.min(polWethPrice, polUsdcPriceInWeth)) * 100).toFixed(4)}%`
            });

            // Vérification du prix du gas
            const gasPrice = await this.provider.getGasPrice();
            const gasPriceGwei = ethers.utils.formatUnits(gasPrice, 'gwei');
            logger.info('⛽ Prix du gas:', {
                price: `${gasPriceGwei} Gwei`,
                maxAcceptable: `${process.env.MAX_GAS_PRICE_GWEI || '50'} Gwei`
            });

            // Tentative de trade si le gas est acceptable
            if (parseFloat(gasPriceGwei) <= parseFloat(process.env.MAX_GAS_PRICE_GWEI || '50')) {
                logger.info('🎯 Conditions favorables, tentative de trade...');
                await this.executeArbitrage(polWethPool, polUsdcPool, polWethPrice, polUsdcPriceInWeth);
            } else {
                logger.warn('⚠️ Prix du gas trop élevé pour trader');
            }

            logger.info('✅ Cycle de monitoring terminé');

        } catch (error) {
            logger.error('❌ Erreur lors du monitoring:', {
                message: error.message,
                stack: error.stack
            });
            await this.sendAlert(`❌ Erreur de monitoring: ${error.message}`);
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

    async initializeTelegramBot() {
        try {
            logger.info('Initialisation du bot Telegram...');
            
            // Création du bot sans polling
            this.telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
                polling: false // Désactivation du polling
            });

            // Test de la connexion
            const botInfo = await this.telegramBot.getMe();
            logger.info(`Bot Telegram connecté: ${botInfo.username}`);
            
            // Envoi d'un message de test
            await this.sendAlert('🤖 Bot d\'arbitrage connecté et prêt!');
            
            return true;
        } catch (error) {
            logger.error('Erreur lors de l\'initialisation du bot Telegram:', error);
            return false;
        }
    }

    async sendAlert(message) {
        try {
            if (!this.telegramBot) {
                logger.warn('Bot Telegram non initialisé, impossible d\'envoyer l\'alerte');
                return;
            }
            
            await this.telegramBot.sendMessage(process.env.TELEGRAM_CHAT_ID, message);
            logger.info('Notification Telegram envoyée');
        } catch (error) {
            logger.error('Erreur lors de l\'envoi de la notification Telegram:', error);
        }
    }

    async start() {
        try {
            logger.info('🚀 Démarrage du bot d\'arbitrage...');
            
            // Vérification des adresses
            logger.info('📝 Vérification des adresses...');
            logger.info(`POL: ${this.POL}`);
            logger.info(`WETH: ${this.WETH}`);
            logger.info(`USDC: ${this.USDC}`);

            // Initialisation du bot Telegram
            const telegramInitialized = await this.initializeTelegramBot();
            if (!telegramInitialized) {
                logger.error('❌ Échec de l\'initialisation du bot Telegram');
                return;
            }

            // Démarrage du serveur Express
            this.initExpressServer();

            // Démarrage du monitoring
            this.startMonitoring();

            // Envoi d'un message de confirmation
            await this.sendAlert('🤖 Bot démarré et prêt à trader!');
            
        } catch (error) {
            logger.error('❌ Erreur lors du démarrage:', error);
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

    async getPool(tokenA, tokenB) {
        try {
            const factoryContract = new ethers.Contract(
                process.env.QUICKSWAP_FACTORY_ADDRESS,
                ['function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'],
                this.provider
            );

            // Essai avec différents frais (0.3%, 0.05%, 1%)
            const fees = [3000, 500, 10000];
            let poolAddress = null;

            for (const fee of fees) {
                poolAddress = await factoryContract.getPool(tokenA.address, tokenB.address, fee);
                if (poolAddress && poolAddress !== ethers.constants.AddressZero) {
                    logger.info(`Pool trouvé pour ${tokenA.symbol}/${tokenB.symbol} avec frais ${fee/10000}%`);
                    break;
                }
            }

            if (!poolAddress || poolAddress === ethers.constants.AddressZero) {
                logger.error(`Aucun pool trouvé pour ${tokenA.symbol}/${tokenB.symbol}`);
                return null;
            }

            const poolContract = new ethers.Contract(
                poolAddress,
                [
                    'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
                    'function liquidity() external view returns (uint128)'
                ],
                this.provider
            );

            const [slot0, liquidity] = await Promise.all([
                poolContract.slot0(),
                poolContract.liquidity()
            ]);

            // Vérification de la liquidité minimale
            const liquidityETH = ethers.utils.formatEther(liquidity);
            if (parseFloat(liquidityETH) < parseFloat(process.env.MIN_POOL_LIQUIDITY_ETH)) {
                logger.warn(`Liquidité insuffisante dans le pool ${tokenA.symbol}/${tokenB.symbol}: ${liquidityETH} ETH`);
                return null;
            }

            logger.info(`Pool ${tokenA.symbol}/${tokenB.symbol} validé avec ${liquidityETH} ETH de liquidité`);
            return { address: poolAddress, slot0, liquidity };

        } catch (error) {
            logger.error(`Erreur lors de la récupération du pool ${tokenA.symbol}/${tokenB.symbol}:`, error);
            return null;
        }
    }

    async getPrice(pool) {
        try {
            if (!pool) {
                throw new Error('Pool non défini');
            }

            const poolContract = new ethers.Contract(
                pool.address,
                [
                    'function token0() external view returns (address)',
                    'function token1() external view returns (address)',
                    'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
                ],
                this.provider
            );

            const [token0Address, token1Address, slot0] = await Promise.all([
                poolContract.token0(),
                poolContract.token1(),
                poolContract.slot0()
            ]);

            const sqrtPriceX96 = slot0.sqrtPriceX96;
            const Q96 = ethers.BigNumber.from('2').pow(96);
            
            // Calcul du prix en fonction de l'ordre des tokens
            let price;
            if (token0Address.toLowerCase() === this.POL.address.toLowerCase()) {
                price = sqrtPriceX96.mul(sqrtPriceX96).div(Q96).div(Q96);
            } else {
                price = Q96.mul(Q96).div(sqrtPriceX96).div(sqrtPriceX96);
            }

            return ethers.utils.formatUnits(price, 18);

        } catch (error) {
            logger.error('Erreur lors de la récupération du prix:', error);
            return null;
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