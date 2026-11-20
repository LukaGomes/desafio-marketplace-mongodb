// Desafio Técnico Back-End: Engenharia de Dados com MongoDB
// Parte 4 — Amostra do banco instanciado pelo seed
//
// Exibe, para cada coleção: quantidade de documentos, tamanho, índices existentes
// e um documento de exemplo. Mostra também a distribuição dos pedidos por status e cidade.
// Tudo é calculado no banco. A saída também é salva em docs/parte-4/amostra.txt.

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const util = require('util');
const { MongoClient } = require('mongodb');

const URI = process.env.SEED_MONGO_URI || 'mongodb://localhost:27017/?replicaSet=rs0';
const DB_NAME = process.env.SEED_DB_NAME || 'marketplace_seed';

const linhas = [];
const log = (texto = '') => {
  console.log(texto);
  linhas.push(texto);
};
const formatar = (obj) => util.inspect(obj, { depth: null, colors: false, breakLength: 100 });
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

async function main() {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db(DB_NAME);

    log(`AMOSTRA DO BANCO "${DB_NAME}"`);
    log(`Gerada em: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
    log('='.repeat(70));

    for (const nome of ['products', 'users', 'orders']) {
      const colecao = db.collection(nome);
      const [stats] = await colecao.aggregate([{ $collStats: { storageStats: {} } }]).toArray();
      const s = stats.storageStats;
      const indices = await colecao.indexes();
      const exemplo = await colecao.findOne({}, { sort: { _id: 1 } });

      log(`\nColeção: ${nome}`);
      log('-'.repeat(70));
      log(`Documentos:            ${s.count.toLocaleString('pt-BR')}`);
      log(`Tamanho dos dados:     ${s.size > 1024 * 1024 ? mb(s.size) : kb(s.size)}`);
      log(`Tamanho médio por doc: ${s.avgObjSize} bytes`);
      log(`Índices (${indices.length}):          ${indices.map((i) => i.name).join(', ')}`);
      log('Documento de exemplo:');
      log(formatar(exemplo));
    }

    const orders = db.collection('orders');

    log('\n' + '='.repeat(70));
    log('Distribuição dos pedidos por status');
    log('-'.repeat(70));
    const porStatus = await orders
      .aggregate([{ $group: { _id: '$status', pedidos: { $sum: 1 } } }, { $sort: { pedidos: -1 } }])
      .toArray();
    porStatus.forEach((r) => log(`${r._id.padEnd(12)} ${r.pedidos.toLocaleString('pt-BR')}`));

    log('\nDistribuição dos pedidos por cidade de entrega');
    log('-'.repeat(70));
    const porCidade = await orders
      .aggregate([{ $group: { _id: '$shippingCity', pedidos: { $sum: 1 } } }, { $sort: { pedidos: -1 } }])
      .toArray();
    porCidade.forEach((r) => log(`${r._id.padEnd(16)} ${r.pedidos.toLocaleString('pt-BR')}`));

    log('\nPeríodo e volume dos pedidos');
    log('-'.repeat(70));
    const [periodo] = await orders
      .aggregate([
        {
          $group: {
            _id: null,
            primeiro: { $min: '$createdAt' },
            ultimo: { $max: '$createdAt' },
            faturamento: { $sum: '$totalAmount' },
            mediaItens: { $avg: { $size: '$items' } },
          },
        },
      ])
      .toArray();
    log(`Pedido mais antigo:    ${periodo.primeiro.toISOString().slice(0, 10)}`);
    log(`Pedido mais recente:   ${periodo.ultimo.toISOString().slice(0, 10)}`);
    log(`Soma de totalAmount:   R$ ${periodo.faturamento.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    log(`Média de itens/pedido: ${periodo.mediaItens.toFixed(2)}`);

    log('\nObservação: as coleções possuem apenas o índice padrão "_id_" (sem índices secundários),');
    log('conforme o enunciado. A otimização é tratada na Tarefa 3.');

    const destino = path.join(__dirname, 'docs', 'parte-4', 'amostra.txt');
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, linhas.join('\n') + '\n', 'utf8');
    console.log(`\nSaída salva em ${path.relative(process.cwd(), destino)}`);
  } catch (err) {
    console.error('Erro ao gerar a amostra:', err.message);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main();
