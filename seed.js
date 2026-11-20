// Desafio Técnico Back-End: Engenharia de Dados com MongoDB
// Parte 4 — Script de Seed
//
// Gera 1.000 produtos, 5.000 usuários e 100.000 pedidos usando insertMany em lotes.
// A estrutura foi mantida propositalmente SEM índices secundários: o diagnóstico e a
// otimização dos gargalos são feitos na Tarefa 3.
//
// Ajustes em relação ao script de referência:
//  - A URI e o nome do banco podem ser definidos no .env (com valores padrão).
//  - O banco padrão é "marketplace_seed", e não "marketplace": como o script executa
//    dropDatabase(), usar o mesmo banco da API (Parte 3) apagaria aqueles dados.
//  - Trava de segurança: o script se recusa a apagar o banco da API.
//  - Ao final, exibe o tempo de execução e a contagem de documentos de cada coleção.

require('dotenv').config({ quiet: true });
const { MongoClient, ObjectId } = require('mongodb');

// replicaSet=rs0 é necessário para as transações da Tarefa 4
const URI = process.env.SEED_MONGO_URI || 'mongodb://localhost:27017/?replicaSet=rs0';
const DB_NAME = process.env.SEED_DB_NAME || 'marketplace_seed';

const CATEGORIES = ['Eletrônicos', 'Livros', 'Casa e Cozinha', 'Esportes', 'Moda'];
const STATUSES = ['PAID', 'PENDING', 'SHIPPED', 'DELIVERED', 'CANCELED'];
const CITIES = ['São Paulo', 'Rio de Janeiro', 'Belo Horizonte', 'Curitiba', 'Porto Alegre', 'Recife'];

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function runSeed() {
  if (DB_NAME === 'marketplace') {
    console.error('Abortado: o seed apaga o banco inteiro e "marketplace" é o banco da API (Parte 3).');
    console.error('Use outro nome em SEED_DB_NAME (padrão: marketplace_seed).');
    process.exit(1);
  }

  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 });
  const inicio = Date.now();

  try {
    await client.connect();
    console.log(`Conectado ao MongoDB... (banco: ${DB_NAME})`);
    const db = client.db(DB_NAME);

    // Limpa coleções anteriores
    await db.dropDatabase();

    // 1. Gerar 1.000 Produtos
    console.log('Gerando 1.000 produtos...');
    const products = [];
    for (let i = 1; i <= 1000; i++) {
      products.push({
        _id: new ObjectId(),
        sku: `SKU-${String(i).padStart(5, '0')}`,
        name: `Produto Exemplo ${i}`,
        category: randomItem(CATEGORIES),
        price: Number((Math.random() * 500 + 20).toFixed(2)),
        stock: randomInt(10, 500),
        sellerId: `SELLER-${randomInt(1, 50)}`,
        active: Math.random() > 0.1,
      });
    }
    await db.collection('products').insertMany(products);

    // 2. Gerar 5.000 Usuários (com carteira digital)
    console.log('Gerando 5.000 usuários...');
    const users = [];
    for (let i = 1; i <= 5000; i++) {
      users.push({
        _id: new ObjectId(),
        name: `Cliente ${i}`,
        email: `cliente${i}@exemplo.com`,
        city: randomItem(CITIES),
        walletBalance: Number((Math.random() * 2000 + 100).toFixed(2)),
        createdAt: new Date(Date.now() - randomInt(0, 365) * 86400000),
      });
    }
    await db.collection('users').insertMany(users);

    // 3. Gerar 100.000 Pedidos em lotes de 10.000
    console.log('Gerando 100.000 pedidos...');
    const TOTAL_ORDERS = 100000;
    const BATCH_SIZE = 10000;

    for (let b = 0; b < TOTAL_ORDERS / BATCH_SIZE; b++) {
      const ordersBatch = [];
      for (let i = 0; i < BATCH_SIZE; i++) {
        const user = randomItem(users);
        const numItems = randomInt(1, 4);
        const items = [];
        let totalAmount = 0;

        for (let j = 0; j < numItems; j++) {
          const prod = randomItem(products);
          const qty = randomInt(1, 3);
          items.push({
            productId: prod._id,
            sku: prod.sku,
            category: prod.category,
            unitPrice: prod.price,
            quantity: qty,
          });
          totalAmount += prod.price * qty;
        }

        ordersBatch.push({
          userId: user._id,
          shippingCity: user.city,
          status: randomItem(STATUSES),
          items: items,
          totalAmount: Number(totalAmount.toFixed(2)),
          createdAt: new Date(Date.now() - randomInt(0, 180) * 86400000),
        });
      }
      await db.collection('orders').insertMany(ordersBatch);
      console.log(`Inseridos ${(b + 1) * BATCH_SIZE} pedidos...`);
    }

    // Conferência final
    const [p, u, o] = await Promise.all([
      db.collection('products').countDocuments(),
      db.collection('users').countDocuments(),
      db.collection('orders').countDocuments(),
    ]);
    console.log('\nSeed finalizado com sucesso!');
    console.log(`Tempo total: ${((Date.now() - inicio) / 1000).toFixed(1)} s`);
    console.log(`products: ${p} | users: ${u} | orders: ${o}`);
  } catch (err) {
    console.error('Erro ao executar seed:', err.message);
    if (err.name === 'MongoServerSelectionError') {
      console.error('Dica: confira se o MongoDB está rodando e se o replica set "rs0" foi iniciado (rs.status()).');
    }
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

runSeed();
