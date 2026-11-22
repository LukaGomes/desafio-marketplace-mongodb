// Desafio Técnico Back-End: Engenharia de Dados com MongoDB
// Tarefa 3 — Diagnóstico e Otimização de Performance
//
// Consulta reportada como lenta:
//   db.orders.find({ shippingCity: "São Paulo", status: "DELIVERED",
//                    createdAt: { $gte: <30 dias atrás> } }).sort({ createdAt: -1 })
//
// Passos executados pelo script:
//   1. Remove o índice da solução, se já existir (para o "antes" ser medido sem ele)
//   2. Roda explain("executionStats") na consulta original (sem índice)
//   3. Cria o índice composto pela regra ESR: { shippingCity: 1, status: 1, createdAt: -1 }
//   4. Roda explain("executionStats") novamente e compara os indicadores
//   5. (Comparação extra) Testa, com hint, duas ordens de índice que violam a regra ESR,
//      para mostrar por que a ordem dos campos importa. Esses índices são temporários.
//
// Uso: npm run tarefa3
// Saída: terminal + tarefas/tarefa-3/resultado.json (+ explain completo antes/depois)

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
const { MongoClient } = require('mongodb');

const URI = process.env.SEED_MONGO_URI || 'mongodb://localhost:27017/?replicaSet=rs0';
const DB_NAME = process.env.SEED_DB_NAME || 'marketplace_seed';

const RODADAS = 5; // cada explain é repetido para não depender de uma medição isolada
const INDICE_ESR = { shippingCity: 1, status: 1, createdAt: -1 };
const NOME_INDICE = 'idx_shippingCity_status_createdAt_ESR';

// Índices "errados" usados só na comparação extra
const ALTERNATIVAS = [
  {
    nome: 'tmp_range_primeiro',
    chave: { createdAt: -1, shippingCity: 1, status: 1 },
    descricao: 'Range/Sort antes das igualdades (createdAt, shippingCity, status)',
  },
  {
    nome: 'tmp_sem_campo_de_ordenacao',
    chave: { shippingCity: 1, status: 1 },
    descricao: 'Só as igualdades, sem o campo de ordenação (shippingCity, status)',
  },
];

// Percorre a árvore do plano e devolve os estágios na ordem de execução (ex.: COLLSCAN -> SORT)
function estagios(plano) {
  if (!plano) return [];
  const filhos = plano.inputStage ? [plano.inputStage] : plano.inputStages || [];
  return [...filhos.flatMap(estagios), plano.stage];
}

// Nome do índice usado (se houver)
function indiceUsado(plano) {
  if (!plano) return null;
  if (plano.indexName) return plano.indexName;
  const filhos = plano.inputStage ? [plano.inputStage] : plano.inputStages || [];
  for (const f of filhos) {
    const n = indiceUsado(f);
    if (n) return n;
  }
  return null;
}

async function medir(colecao, filtro, ordenacao, hint) {
  const tempos = [];
  let ultimo;
  for (let i = 0; i < RODADAS; i++) {
    let cursor = colecao.find(filtro).sort(ordenacao);
    if (hint) cursor = cursor.hint(hint);
    ultimo = await cursor.explain('executionStats');
    tempos.push(ultimo.executionStats.executionTimeMillis);
  }
  const wp = ultimo.queryPlanner.winningPlan;
  const plano = wp.queryPlan || wp; // motor SBE (MongoDB 7+) usa winningPlan.queryPlan
  const s = ultimo.executionStats;
  return {
    estagios: estagios(plano).join(' -> '),
    indice: indiceUsado(plano),
    nReturned: s.nReturned,
    totalKeysExamined: s.totalKeysExamined,
    totalDocsExamined: s.totalDocsExamined,
    executionTimeMillis: {
      primeira: tempos[0],
      minimo: Math.min(...tempos),
      media: Number((tempos.reduce((a, b) => a + b, 0) / tempos.length).toFixed(1)),
      todas: tempos,
    },
    explainCompleto: ultimo,
  };
}

const linha = (rotulo, a, d) =>
  console.log(rotulo.padEnd(26) + String(a).padStart(24) + String(d).padStart(26));

async function main() {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const orders = client.db(DB_NAME).collection('orders');

    // Mesma janela de datas para o "antes" e o "depois" (comparação justa)
    const agora = new Date();
    const desde = new Date(agora.getTime() - 30 * 86400000);
    const filtro = { shippingCity: 'São Paulo', status: 'DELIVERED', createdAt: { $gte: desde } };
    const ordenacao = { createdAt: -1 };

    console.log(`TAREFA 3: DIAGNÓSTICO E OTIMIZAÇÃO (banco: ${DB_NAME})`);
    console.log(`Executado em: ${agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
    console.log(`Filtro: shippingCity="São Paulo", status="DELIVERED", createdAt >= ${desde.toISOString()}`);
    console.log(`Ordenação: { createdAt: -1 } · ${RODADAS} execuções de explain por cenário`);
    console.log('='.repeat(76));

    // 1) Garante o cenário inicial: sem o índice da solução
    const existentes = await orders.indexes();
    for (const nome of [NOME_INDICE, ...ALTERNATIVAS.map((a) => a.nome)]) {
      if (existentes.some((i) => i.name === nome)) await orders.dropIndex(nome);
    }
    console.log(`Índices antes: ${(await orders.indexes()).map((i) => i.name).join(', ')}`);

    // 2) ANTES
    const antes = await medir(orders, filtro, ordenacao);

    // 3) Cria o índice ESR
    await orders.createIndex(INDICE_ESR, { name: NOME_INDICE });
    console.log(`Índice criado: ${NOME_INDICE} ${JSON.stringify(INDICE_ESR)}`);

    // 4) DEPOIS
    const depois = await medir(orders, filtro, ordenacao);

    console.log('\nCOMPARAÇÃO');
    console.log('-'.repeat(76));
    linha('Indicador', 'ANTES (sem índice)', 'DEPOIS (índice ESR)');
    console.log('-'.repeat(76));
    linha('Estágios do plano', antes.estagios, depois.estagios);
    linha('Índice utilizado', antes.indice || '(nenhum)', depois.indice);
    linha('nReturned', antes.nReturned, depois.nReturned);
    linha('totalKeysExamined', antes.totalKeysExamined, depois.totalKeysExamined);
    linha('totalDocsExamined', antes.totalDocsExamined, depois.totalDocsExamined);
    linha('executionTimeMillis (1ª)', antes.executionTimeMillis.primeira, depois.executionTimeMillis.primeira);
    linha('executionTimeMillis (méd.)', antes.executionTimeMillis.media, depois.executionTimeMillis.media);
    linha('executionTimeMillis (mín.)', antes.executionTimeMillis.minimo, depois.executionTimeMillis.minimo);
    console.log('-'.repeat(76));
    const reducaoDocs = (1 - depois.totalDocsExamined / antes.totalDocsExamined) * 100;
    console.log(`Documentos examinados: ${antes.totalDocsExamined} -> ${depois.totalDocsExamined} (redução de ${reducaoDocs.toFixed(2)}%)`);
    console.log(`Eficiência (docs examinados por doc retornado): ` +
      `${(antes.totalDocsExamined / antes.nReturned).toFixed(1)} -> ${(depois.totalDocsExamined / depois.nReturned).toFixed(1)}`);

    // 5) Comparação extra: por que a ordem ESR importa
    console.log('\nCOMPARAÇÃO EXTRA: ORDEM DOS CAMPOS NO ÍNDICE (com hint)');
    console.log('-'.repeat(76));
    const alternativas = [];
    for (const alt of ALTERNATIVAS) {
      await orders.createIndex(alt.chave, { name: alt.nome });
      const r = await medir(orders, filtro, ordenacao, alt.nome);
      await orders.dropIndex(alt.nome);
      alternativas.push({ ...alt, ...r, explainCompleto: undefined });
      console.log(`${alt.descricao}`);
      console.log(`  estágios: ${r.estagios} | keys: ${r.totalKeysExamined} | docs: ${r.totalDocsExamined} | ` +
        `retornados: ${r.nReturned} | tempo médio: ${r.executionTimeMillis.media} ms`);
    }
    console.log(`Índice ESR (solução)`);
    console.log(`  estágios: ${depois.estagios} | keys: ${depois.totalKeysExamined} | docs: ${depois.totalDocsExamined} | ` +
      `retornados: ${depois.nReturned} | tempo médio: ${depois.executionTimeMillis.media} ms`);

    console.log(`\nÍndices finais: ${(await orders.indexes()).map((i) => i.name).join(', ')}`);

    // Salva os resultados
    const resumo = (r) => ({ ...r, explainCompleto: undefined });
    fs.writeFileSync(
      path.join(__dirname, 'resultado.json'),
      JSON.stringify({ executadoEm: agora.toISOString(), desde: desde.toISOString(), rodadas: RODADAS,
        indiceCriado: { nome: NOME_INDICE, chave: INDICE_ESR },
        antes: resumo(antes), depois: resumo(depois), alternativas }, null, 2),
      'utf8',
    );
    fs.writeFileSync(path.join(__dirname, 'explain-antes.json'), JSON.stringify(antes.explainCompleto, null, 2), 'utf8');
    fs.writeFileSync(path.join(__dirname, 'explain-depois.json'), JSON.stringify(depois.explainCompleto, null, 2), 'utf8');
    console.log('Resultados salvos em tarefas/tarefa-3/ (resultado.json, explain-antes.json, explain-depois.json)');
  } catch (err) {
    console.error('Erro na Tarefa 3:', err.message);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main();
