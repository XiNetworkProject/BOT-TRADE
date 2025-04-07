# Bot d'Arbitrage QuickSwap

Ce bot surveille les opportunités d'arbitrage entre différentes pools de QuickSwap sur le réseau Polygon, en se concentrant sur les paires POL/WETH et POL/USDC.

## Prérequis

- Node.js (version 14 ou supérieure)
- Un wallet Ethereum avec des fonds sur Polygon
- Une clé privée pour signer les transactions

## Installation

1. Clonez ce dépôt :
```bash
git clone [URL_DU_REPO]
cd quickswap-arbitrage-bot
```

2. Installez les dépendances :
```bash
npm install
```

3. Configurez les variables d'environnement :
- Copiez le fichier `.env.example` en `.env`
- Remplissez les variables avec vos informations

## Configuration

Modifiez le fichier `.env` avec vos paramètres :

- `POLYGON_RPC_URL` : URL du nœud RPC Polygon
- `PRIVATE_KEY` : Votre clé privée (gardez-la secrète !)
- `MIN_PROFIT_THRESHOLD` : Seuil de profit minimum pour déclencher un arbitrage
- `SLIPPAGE_TOLERANCE` : Tolérance au slippage acceptée

## Utilisation

Démarrez le bot :
```bash
npm start
```

Le bot surveillera automatiquement les pools et exécutera des trades lorsqu'une opportunité d'arbitrage sera détectée.

## Sécurité

⚠️ IMPORTANT : Ne partagez jamais votre clé privée ou votre fichier `.env` !

## Structure du Projet

- `src/index.js` : Point d'entrée principal du bot
- `.env` : Configuration et variables d'environnement
- `package.json` : Dépendances et scripts

## Contribution

Les contributions sont les bienvenues ! N'hésitez pas à ouvrir une issue ou une pull request.

## Licence

MIT 