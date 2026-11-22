// Desafio Técnico Back-End: Engenharia de Dados com MongoDB
// Tarefa 2 — Aggregation Framework
//
// Executa dois pipelines de agregação DIRETAMENTE NO BANCO (nenhum array é processado
// na memória da aplicação; o Node apenas exibe o resultado final):
//   1. Relatório de faturamento por categoria (últimos 90 dias, pedidos PAID/SHIPPED/DELIVERED)
//   2. Ranking de clientes VIP de São Paulo, paginado com $facet
//
// Uso:  npm run tarefa2                  (página 1 do ranking)
//       npm run tarefa2 -- 2             (página 2 do ranking)
//
// A saída é exibida no terminal e salva em tarefas/tarefa-2/resultado-pagina-N.json

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
const { MongoClient } = require('mongodb');

const URI = process.env.SEED_MONGO_URI || 'mongodb://localhost:27017/?replicaSet=rs0';
const DB_NAME = process.env.SEED_DB_NAME || 'marketplace_seed';

const STATUS_VALIDOS = ['PAID', 'SHIPPED', 'DELIVERED'];
const DIA_MS = 24 * 60 * 60 * 1000;

const pagina = Math.max(1, parseInt(process.argv[2], 10) || 1);
const TAMANHO_PAGINA = 10;

// ---------------------------------------------------------------------------
// Pipeline 1: faturamento por categoria
// ---------------------------------------------------------------------------
function pipelineFaturamentoPorCategoria(dataInicial) {
  return [
    // 1) Filtra o mais cedo possível: só pedidos pagos/enviados/entregues dos últimos 90 dias.
    //    Reduz o volume que segue para as próximas etapas.
    {
      $match: {
        status: { $in: STATUS_VALIDOS },
        createdAt: { $gte: dataInicial },
      },
    },
    // 2) "Desmonta" o array de itens: cada item vira um documento separado,
    //    porque um mesmo pedido pode ter itens de categorias diferentes.
    { $unwind: '$items' },
    // 3) Agrupa por categoria. A categoria já está copiada dentro do item (desnormalização),
    //    então não é preciso $lookup na coleção products.
    {
      $group: {
        _id: '$items.category',
        faturamentoTotal: { $sum: { $multiply: ['$items.unitPrice', '$items.quantity'] } },
        itensVendidos: { $sum: '$items.quantity' },
        pedidos: { $sum: 1 }, // linhas de pedido (pedido x item) da categoria
      },
    },
    // 4) Ordena do maior faturamento para o menor
    { $sort: { faturamentoTotal: -1 } },
    // 5) Formata a saída
    {
      $project: {
        _id: 0,
        categoria: '$_id',
        faturamentoTotal: { $round: ['$faturamentoTotal', 2] },
        itensVendidos: 1,
        linhasDePedido: '$pedidos',
        ticketMedioPorItem: { $round: [{ $divide: ['$faturamentoTotal', '$itensVendidos'] }, 2] },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Pipeline 2: ranking de clientes VIP (paginado com $facet)
// ---------------------------------------------------------------------------
function pipelineClientesVip(numeroPagina, tamanhoPagina) {
  return [
    // 1) Filtra pedidos entregues em São Paulo que representam gasto efetivo
    //    (pedidos PENDING e CANCELED não são considerados gasto)
    {
      $match: {
        shippingCity: 'São Paulo',
        status: { $in: STATUS_VALIDOS },
      },
    },
    // 2) Soma o gasto e conta os pedidos de cada cliente
    {
      $group: {
        _id: '$userId',
        totalGasto: { $sum: '$totalAmount' },
        quantidadePedidos: { $sum: 1 },
      },
    },
    // 3) Ordena do maior gasto para o menor (_id desempata, deixando a paginação estável)
    { $sort: { totalGasto: -1, _id: 1 } },
    // 4) $facet: duas "sub-pipelines" sobre o mesmo resultado, numa única consulta
    {
      $facet: {
        // Contagem total de clientes elegíveis (para calcular o número de páginas)
        metadados: [{ $count: 'totalClientes' }],
        // Dados da página solicitada. O $lookup em users acontece só para os 10 clientes
        // da página, e não para todos os clientes elegíveis.
        dados: [
          { $skip: (numeroPagina - 1) * tamanhoPagina },
          { $limit: tamanhoPagina },
          {
            $lookup: {
              from: 'users',
              localField: '_id',
              foreignField: '_id',
              as: 'usuario',
            },
          },
          { $unwind: '$usuario' },
          {
            $project: {
              _id: 0,
              userId: '$_id',
              nome: '$usuario.name',
              email: '$usuario.email',
              totalGasto: { $round: ['$totalGasto', 2] },
              quantidadePedidos: 1,
            },
          },
        ],
      },
    },
    // 5) Monta a resposta final com os dados da paginação
    {
      $project: {
        totalClientes: { $ifNull: [{ $arrayElemAt: ['$metadados.totalClientes', 0] }, 0] },
        pagina: { $literal: numeroPagina },
        tamanhoPagina: { $literal: tamanhoPagina },
        dados: 1,
      },
    },
    {
      $set: {
        totalPaginas: { $ceil: { $divide: ['$totalClientes', tamanhoPagina] } },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------
const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (v) => v.toLocaleString('pt-BR');

async function main() {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const orders = client.db(DB_NAME).collection('orders');

    const agora = new Date();
    const dataInicial = new Date(agora.getTime() - 90 * DIA_MS);
    const dataBR = (d) => d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    console.log(`TAREFA 2: AGGREGATION FRAMEWORK (banco: ${DB_NAME})`);
    console.log(`Executado em: ${dataBR(agora)}`);
    console.log('='.repeat(78));

    // ---- Relatório 1
    let inicio = Date.now();
    const faturamento = await orders.aggregate(pipelineFaturamentoPorCategoria(dataInicial)).toArray();
    const tempo1 = Date.now() - inicio;

    console.log('\n1. FATURAMENTO POR CATEGORIA');
    console.log(`Pedidos PAID, SHIPPED ou DELIVERED desde ${dataBR(dataInicial)} (últimos 90 dias)`);
    console.log('-'.repeat(78));
    console.log('Categoria'.padEnd(18) + 'Faturamento'.padStart(22) + 'Itens vendidos'.padStart(18));
    faturamento.forEach((c) =>
      console.log(c.categoria.padEnd(18) + brl(c.faturamentoTotal).padStart(22) + num(c.itensVendidos).padStart(18)),
    );
    console.log(`Tempo de execução: ${tempo1} ms`);

    // ---- Relatório 2
    inicio = Date.now();
    const [ranking] = await orders.aggregate(pipelineClientesVip(pagina, TAMANHO_PAGINA)).toArray();
    const tempo2 = Date.now() - inicio;

    console.log('\n2. RANKING DE CLIENTES VIP: SÃO PAULO');
    console.log(`Página ${ranking.pagina} de ${ranking.totalPaginas} · ${num(ranking.totalClientes)} clientes elegíveis`);
    console.log('-'.repeat(78));
    console.log('#'.padEnd(5) + 'Nome'.padEnd(16) + 'E-mail'.padEnd(28) + 'Total gasto'.padStart(16) + 'Pedidos'.padStart(10));
    ranking.dados.forEach((c, i) => {
      const pos = (ranking.pagina - 1) * ranking.tamanhoPagina + i + 1;
      console.log(
        String(pos).padEnd(5) + c.nome.padEnd(16) + c.email.padEnd(28) +
        brl(c.totalGasto).padStart(16) + String(c.quantidadePedidos).padStart(10),
      );
    });
    console.log(`Tempo de execução: ${tempo2} ms`);

    const saida = {
      executadoEm: agora.toISOString(),
      banco: DB_NAME,
      relatorio1: { dataInicial: dataInicial.toISOString(), tempoMs: tempo1, resultado: faturamento },
      relatorio2: { tempoMs: tempo2, resultado: ranking },
    };
    const destino = path.join(__dirname, `resultado-pagina-${pagina}.json`);
    fs.writeFileSync(destino, JSON.stringify(saida, null, 2), 'utf8');
    console.log(`\nResultado salvo em ${path.relative(process.cwd(), destino)}`);
  } catch (err) {
    console.error('Erro ao executar os relatórios:', err.message);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main();
