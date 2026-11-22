// Desafio Técnico Back-End: Engenharia de Dados com MongoDB
// Tarefa 4 — Consistência e Transações ACID
//
// Função transacional de checkout: recebe userId, productId e quantity e executa,
// de forma ATÔMICA (tudo ou nada):
//   1. Verifica se o produto existe e se stock >= quantity
//   2. Verifica se o usuário possui walletBalance >= price * quantity
//   3. Debita o estoque do produto ($inc)
//   4. Debita o saldo da carteira do usuário ($inc)
//   5. Insere o novo pedido na coleção orders com status "PAID"
// Se qualquer validação falhar ou ocorrer um erro no meio do processo, a transação
// sofre rollback (abortTransaction) e nenhum saldo ou estoque fica inconsistente.
//
// Requisito: MongoDB em replica set (transações não funcionam em servidor standalone).
//
// Uso: npm run tarefa4   (executa os cenários de demonstração)

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });
const { MongoClient, ObjectId } = require('mongodb');

const URI = process.env.SEED_MONGO_URI || 'mongodb://localhost:27017/?replicaSet=rs0';
const DB_NAME = process.env.SEED_DB_NAME || 'marketplace_seed';

const arredondar = (v) => Math.round(v * 100) / 100;

// Erro de regra de negócio: provoca o rollback com uma mensagem clara
class CheckoutError extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.codigo = codigo;
  }
}

/**
 * Checkout transacional.
 * @param {MongoClient} client
 * @param {{ userId: string|ObjectId, productId: string|ObjectId, quantity: number }} pedido
 * @param {{ simularFalhaApos?: 'estoque'|'carteira', log?: Function }} opcoes  (simularFalhaApos: só para demonstração)
 * @returns {Promise<object>} o pedido criado
 */
async function checkout(client, { userId, productId, quantity }, opcoes = {}) {
  const log = opcoes.log || (() => {});
  const db = client.db(DB_NAME);
  const products = db.collection('products');
  const users = db.collection('users');
  const orders = db.collection('orders');

  // Validação de entrada (antes de abrir a transação)
  if (!ObjectId.isValid(userId) || !ObjectId.isValid(productId)) {
    throw new CheckoutError('ID_INVALIDO', 'userId e productId devem ser ObjectIds válidos.');
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new CheckoutError('QUANTIDADE_INVALIDA', 'quantity deve ser um inteiro maior que zero.');
  }
  const uid = new ObjectId(userId);
  const pid = new ObjectId(productId);

  const session = client.startSession();
  const MAX_TENTATIVAS = 3;

  try {
    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
      session.startTransaction({
        readConcern: { level: 'snapshot' },      // leituras consistentes dentro da transação
        writeConcern: { w: 'majority' },         // confirmação durável no commit
        readPreference: 'primary',
      });
      log('  startTransaction()');

      try {
        // 1) Produto existe e tem estoque suficiente?
        const produto = await products.findOne({ _id: pid }, { session });
        if (!produto) throw new CheckoutError('PRODUTO_NAO_ENCONTRADO', 'Produto não encontrado.');
        if (produto.active === false) throw new CheckoutError('PRODUTO_INATIVO', 'Produto inativo.');
        if (produto.stock < quantity) {
          throw new CheckoutError('ESTOQUE_INSUFICIENTE',
            `Estoque insuficiente: disponível ${produto.stock}, solicitado ${quantity}.`);
        }
        log(`  1. Produto ${produto.sku} encontrado · estoque ${produto.stock} >= ${quantity} ✔`);

        // 2) Usuário existe e tem saldo suficiente?
        const total = arredondar(produto.price * quantity);
        const usuario = await users.findOne({ _id: uid }, { session });
        if (!usuario) throw new CheckoutError('USUARIO_NAO_ENCONTRADO', 'Usuário não encontrado.');
        if (usuario.walletBalance < total) {
          throw new CheckoutError('SALDO_INSUFICIENTE',
            `Saldo insuficiente: saldo R$ ${usuario.walletBalance.toFixed(2)}, total R$ ${total.toFixed(2)}.`);
        }
        log(`  2. Usuário ${usuario.name} · saldo R$ ${usuario.walletBalance.toFixed(2)} >= total R$ ${total.toFixed(2)} ✔`);

        // 3) Debita o estoque ($inc). O filtro repete a condição como proteção extra:
        //    se outra operação tiver alterado o estoque, nada é atualizado.
        const r1 = await products.updateOne(
          { _id: pid, stock: { $gte: quantity } },
          { $inc: { stock: -quantity } },
          { session },
        );
        if (r1.modifiedCount !== 1) throw new CheckoutError('CONFLITO_ESTOQUE', 'O estoque mudou durante o checkout.');
        log(`  3. Estoque debitado ($inc: -${quantity})`);

        if (opcoes.simularFalhaApos === 'estoque') {
          const dentro = await products.findOne({ _id: pid }, { session, projection: { stock: 1 } });
          log(`     (dentro da transação o estoque já é ${dentro.stock})`);
          throw new Error('Falha simulada após debitar o estoque.');
        }

        // 4) Debita o saldo da carteira ($inc)
        const r2 = await users.updateOne(
          { _id: uid, walletBalance: { $gte: total } },
          { $inc: { walletBalance: -total } },
          { session },
        );
        if (r2.modifiedCount !== 1) throw new CheckoutError('CONFLITO_SALDO', 'O saldo mudou durante o checkout.');
        log(`  4. Saldo debitado ($inc: -${total.toFixed(2)})`);

        if (opcoes.simularFalhaApos === 'carteira') {
          const p = await products.findOne({ _id: pid }, { session, projection: { stock: 1 } });
          const u = await users.findOne({ _id: uid }, { session, projection: { walletBalance: 1 } });
          log(`     (dentro da transação: estoque ${p.stock}, saldo R$ ${u.walletBalance.toFixed(2)})`);
          throw new Error('Falha simulada após debitar estoque e carteira (antes de gravar o pedido).');
        }

        // 5) Insere o pedido com status PAID (mesmo formato dos pedidos do seed)
        const pedido = {
          userId: uid,
          shippingCity: usuario.city,
          status: 'PAID',
          items: [{
            productId: pid,
            sku: produto.sku,
            category: produto.category,
            unitPrice: produto.price,
            quantity,
          }],
          totalAmount: total,
          createdAt: new Date(),
        };
        const { insertedId } = await orders.insertOne(pedido, { session });
        log(`  5. Pedido ${insertedId} inserido com status PAID`);

        // Commit (com nova tentativa se o resultado do commit for incerto)
        for (;;) {
          try {
            await session.commitTransaction();
            log('  commitTransaction() ✔');
            break;
          } catch (err) {
            if (err.hasErrorLabel?.('UnknownTransactionCommitResult')) continue;
            throw err;
          }
        }
        return { _id: insertedId, ...pedido };
      } catch (err) {
        if (session.inTransaction()) {
          await session.abortTransaction();
          log(`  abortTransaction() ↩ rollback: ${err.message}`);
        }
        // Erros transitórios (ex.: conflito de escrita entre transações) podem ser repetidos
        if (err.hasErrorLabel?.('TransientTransactionError') && tentativa < MAX_TENTATIVAS) {
          log(`  erro transitório, nova tentativa (${tentativa + 1}/${MAX_TENTATIVAS})`);
          continue;
        }
        throw err;
      }
    }
  } finally {
    await session.endSession();
  }
}

// ---------------------------------------------------------------------------
// Demonstração: cenários de sucesso e de rollback
// ---------------------------------------------------------------------------
async function demonstracao() {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 });
  const linhas = [];
  const out = (t = '') => { console.log(t); linhas.push(t); };
  const resultados = [];

  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const products = db.collection('products');
    const users = db.collection('users');
    const orders = db.collection('orders');

    // Dados de teste escolhidos de forma determinística
    const cliente = await users.findOne({ walletBalance: { $gte: 1500 } }, { sort: { email: 1 } });
    const produto = await products.findOne({ active: true, price: { $lte: 150 }, stock: { $gte: 20 } }, { sort: { sku: 1 } });
    const clientePobre = await users.findOne({ walletBalance: { $lt: 200 } }, { sort: { email: 1 } });
    const produtoCaro = await products.findOne({ active: true, price: { $gte: 400 }, stock: { $gte: 1 } }, { sort: { sku: 1 } });

    const estado = async () => {
      const p = await products.findOne({ _id: produto._id });
      const u = await users.findOne({ _id: cliente._id });
      const pc = await products.findOne({ _id: produtoCaro._id });
      const up = await users.findOne({ _id: clientePobre._id });
      return {
        estoqueProduto: p.stock,
        saldoCliente: arredondar(u.walletBalance),
        estoqueProdutoCaro: pc.stock,
        saldoClientePobre: arredondar(up.walletBalance),
        pedidosCliente: await orders.countDocuments({ userId: cliente._id }),
        pedidosClientePobre: await orders.countDocuments({ userId: clientePobre._id }),
        totalPedidos: await orders.countDocuments(),
      };
    };
    const mostrar = (rotulo, e) => out(
      `${rotulo} estoque ${produto.sku}: ${e.estoqueProduto} | saldo ${cliente.name}: R$ ${e.saldoCliente.toFixed(2)} | ` +
      `pedidos do cliente: ${e.pedidosCliente} | total de pedidos: ${e.totalPedidos}`);

    out(`TAREFA 4: CHECKOUT TRANSACIONAL (banco: ${DB_NAME})`);
    out(`Executado em: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
    out('='.repeat(90));
    out(`Cliente de teste: ${cliente.name} (${cliente._id}) · saldo R$ ${cliente.walletBalance.toFixed(2)}`);
    out(`Produto de teste: ${produto.sku} (${produto._id}) · R$ ${produto.price.toFixed(2)} · estoque ${produto.stock}`);
    out(`Cliente com pouco saldo: ${clientePobre.name} · saldo R$ ${clientePobre.walletBalance.toFixed(2)}`);
    out(`Produto caro: ${produtoCaro.sku} · R$ ${produtoCaro.price.toFixed(2)} · estoque ${produtoCaro.stock}`);

    const cenarios = [
      { titulo: 'CENÁRIO 1: compra válida (2 unidades)', esperado: 'COMMIT',
        args: { userId: cliente._id, productId: produto._id, quantity: 2 } },
      { titulo: 'CENÁRIO 2: estoque insuficiente', esperado: 'ROLLBACK',
        args: async () => ({ userId: cliente._id, productId: produto._id,
          quantity: (await products.findOne({ _id: produto._id })).stock + 1 }) },
      { titulo: 'CENÁRIO 3: saldo insuficiente', esperado: 'ROLLBACK',
        args: { userId: clientePobre._id, productId: produtoCaro._id, quantity: 1 } },
      { titulo: 'CENÁRIO 4: erro no meio do processo (após debitar estoque e carteira)', esperado: 'ROLLBACK',
        args: { userId: cliente._id, productId: produto._id, quantity: 3 }, opcoes: { simularFalhaApos: 'carteira' } },
      { titulo: 'CENÁRIO 5: produto inexistente', esperado: 'ROLLBACK',
        args: { userId: cliente._id, productId: new ObjectId(), quantity: 1 } },
    ];

    for (const c of cenarios) {
      out(`\n${c.titulo}`);
      out('-'.repeat(90));
      const args = typeof c.args === 'function' ? await c.args() : c.args;
      out(`checkout({ userId: ${args.userId}, productId: ${args.productId}, quantity: ${args.quantity} })`);
      const antes = await estado();
      mostrar('ANTES: ', antes);
      let resultado;
      try {
        const pedido = await checkout(client, args, { ...(c.opcoes || {}), log: out });
        resultado = { status: 'COMMIT', pedidoId: String(pedido._id), totalAmount: pedido.totalAmount };
        out(`Resultado: COMMIT · pedido ${pedido._id} · total R$ ${pedido.totalAmount.toFixed(2)}`);
      } catch (err) {
        resultado = { status: 'ROLLBACK', codigo: err.codigo || 'ERRO', motivo: err.message };
        out(`Resultado: ROLLBACK · ${err.message}`);
      }
      const depois = await estado();
      mostrar('DEPOIS:', depois);
      if (c.titulo.startsWith('CENÁRIO 3')) {
        out(`        (cenário 3) estoque ${produtoCaro.sku}: ${antes.estoqueProdutoCaro} -> ${depois.estoqueProdutoCaro} | ` +
          `saldo ${clientePobre.name}: R$ ${antes.saldoClientePobre.toFixed(2)} -> R$ ${depois.saldoClientePobre.toFixed(2)} | ` +
          `pedidos: ${antes.pedidosClientePobre} -> ${depois.pedidosClientePobre}`);
      }
      const inalterado = JSON.stringify(antes) === JSON.stringify(depois);
      const ok = c.esperado === resultado.status && (resultado.status === 'COMMIT' || inalterado);
      out(resultado.status === 'ROLLBACK'
        ? `Verificação: ${inalterado ? 'nenhum estoque, saldo ou pedido foi alterado ✔' : 'ATENÇÃO: houve alteração ✘'}`
        : `Verificação: estoque -${args.quantity}, saldo -R$ ${(antes.saldoCliente - depois.saldoCliente).toFixed(2)}, ` +
          `+${depois.pedidosCliente - antes.pedidosCliente} pedido ✔`);
      resultados.push({ cenario: c.titulo, esperado: c.esperado, ...resultado, antes, depois, ok });
    }

    out('\n' + '='.repeat(90));
    out('RESUMO');
    resultados.forEach((r) => out(`${r.ok ? '✔' : '✘'} ${r.cenario}: ${r.status}${r.codigo ? ` (${r.codigo})` : ''}`));

    const pasta = __dirname;
    fs.writeFileSync(path.join(pasta, 'resultado.json'), JSON.stringify({
      executadoEm: new Date().toISOString(), banco: DB_NAME,
      dadosDeTeste: {
        cliente: { _id: cliente._id, name: cliente.name, saldoInicial: cliente.walletBalance },
        produto: { _id: produto._id, sku: produto.sku, price: produto.price, estoqueInicial: produto.stock },
        clientePobre: { _id: clientePobre._id, name: clientePobre.name, saldo: clientePobre.walletBalance },
        produtoCaro: { _id: produtoCaro._id, sku: produtoCaro.sku, price: produtoCaro.price, estoque: produtoCaro.stock },
      },
      resultados,
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(pasta, 'saida.txt'), linhas.join('\n') + '\n', 'utf8');
    out('\nResultados salvos em tarefas/tarefa-4/ (resultado.json e saida.txt)');
  } catch (err) {
    console.error('Erro na demonstração:', err.message);
    if (/Transaction numbers|replica set/i.test(err.message)) {
      console.error('Dica: transações exigem replica set. Confira rs.status() e a URI com ?replicaSet=rs0.');
    }
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

module.exports = { checkout, CheckoutError };

if (require.main === module) demonstracao();
