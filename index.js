// Desafio Técnico Back-End: Engenharia de Dados com MongoDB
// Parte 1 — Marketplace com armazenamento em memória (Node.js + Express)

const express = require('express');

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Banco de dados em memória
// ---------------------------------------------------------------------------
const db = {
  usuarios: [],
  produtos: [],
  pedidos: [],
};

// Contadores próprios: o id nunca se repete, mesmo que um registro seja removido
// (usar array.length + 1 geraria ids duplicados após uma exclusão).
const proximoId = { usuarios: 1, produtos: 1, pedidos: 1 };
const gerarId = (colecao) => proximoId[colecao]++;

// ---------------------------------------------------------------------------
// Funções auxiliares de validação
// ---------------------------------------------------------------------------

// Aceita 1 ou "1" (Insomnia/Postman podem enviar como texto) e devolve número inteiro positivo.
function paraId(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function inteiroPositivo(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function inteiroNaoNegativo(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function precoValido(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? arredondar(n) : null;
}

// Evita resíduos de ponto flutuante (ex.: 0.1 * 3 = 0.30000000000000004).
const arredondar = (valor) => Math.round(valor * 100) / 100;

const textoValido = (valor) => typeof valor === 'string' && valor.trim().length > 0;

const buscarUsuario = (id) => db.usuarios.find((u) => u.id === id);
const buscarProduto = (id) => db.produtos.find((p) => p.id === id);

// ---------------------------------------------------------------------------
// 1. Usuários (compradores e vendedores)
// ---------------------------------------------------------------------------

// Cadastrar usuário
app.post('/usuarios', (req, res) => {
  const { nome, tipo } = req.body ?? {};

  if (!textoValido(nome) || !['vendedor', 'comprador'].includes(tipo)) {
    return res
      .status(400)
      .json({ erro: 'Informe nome e tipo válido (vendedor/comprador).' });
  }

  const novoUsuario = {
    id: gerarId('usuarios'),
    nome: nome.trim(),
    tipo,
  };

  db.usuarios.push(novoUsuario);
  res.status(201).json(novoUsuario);
});

// Listar usuários (filtro opcional: /usuarios?tipo=vendedor)
app.get('/usuarios', (req, res) => {
  const { tipo } = req.query;
  const lista = tipo ? db.usuarios.filter((u) => u.tipo === tipo) : db.usuarios;
  res.json(lista);
});

// Buscar usuário por id
app.get('/usuarios/:id', (req, res) => {
  const usuario = buscarUsuario(paraId(req.params.id));
  if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  res.json(usuario);
});

// ---------------------------------------------------------------------------
// 2. Produtos
// ---------------------------------------------------------------------------

// Anunciar produto (apenas vendedores)
app.post('/produtos', (req, res) => {
  const { vendedorId, nome, preco, estoque } = req.body ?? {};

  const id = paraId(vendedorId);
  const usuario = id && buscarUsuario(id);

  if (!usuario) {
    return res.status(404).json({ erro: 'Vendedor não encontrado.' });
  }
  if (usuario.tipo !== 'vendedor') {
    return res
      .status(403)
      .json({ erro: 'Apenas usuários do tipo vendedor podem anunciar produtos.' });
  }

  const precoNumerico = precoValido(preco);
  const estoqueNumerico = inteiroNaoNegativo(estoque);

  if (!textoValido(nome) || precoNumerico === null || estoqueNumerico === null) {
    return res.status(400).json({
      erro: 'Informe nome, preço maior que zero e estoque inteiro maior ou igual a zero.',
    });
  }

  const novoProduto = {
    id: gerarId('produtos'),
    vendedorId: id,
    nome: nome.trim(),
    preco: precoNumerico,
    estoque: estoqueNumerico,
  };

  db.produtos.push(novoProduto);
  res.status(201).json(novoProduto);
});

// Listar vitrine (somente produtos com estoque disponível)
app.get('/produtos', (req, res) => {
  const disponiveis = db.produtos.filter((p) => p.estoque > 0);
  res.json(disponiveis);
});

// Buscar produto por id (inclusive sem estoque)
app.get('/produtos/:id', (req, res) => {
  const produto = buscarProduto(paraId(req.params.id));
  if (!produto) return res.status(404).json({ erro: 'Produto não encontrado.' });
  res.json(produto);
});

// ---------------------------------------------------------------------------
// 3. Pedidos
// ---------------------------------------------------------------------------

// Realizar compra (apenas compradores)
app.post('/pedidos', (req, res) => {
  const { compradorId, produtoId, quantidade } = req.body ?? {};

  const idComprador = paraId(compradorId);
  const comprador = idComprador && buscarUsuario(idComprador);

  if (!comprador) {
    return res.status(404).json({ erro: 'Comprador não encontrado.' });
  }
  if (comprador.tipo !== 'comprador') {
    return res
      .status(403)
      .json({ erro: 'Apenas usuários do tipo comprador podem realizar pedidos.' });
  }

  // Sem esta validação, quantidade ausente transformaria o estoque em NaN
  // e quantidade negativa aumentaria o estoque.
  const qtd = inteiroPositivo(quantidade);
  if (qtd === null) {
    return res
      .status(400)
      .json({ erro: 'Informe uma quantidade inteira maior que zero.' });
  }

  const produto = buscarProduto(paraId(produtoId));
  if (!produto) {
    return res.status(404).json({ erro: 'Produto não encontrado.' });
  }
  if (produto.estoque < qtd) {
    return res.status(400).json({
      erro: 'Estoque insuficiente.',
      estoqueDisponivel: produto.estoque,
    });
  }

  // Atualiza o estoque e calcula o valor total.
  // Em memória, este trecho é síncrono: nenhuma outra requisição executa no meio dele.
  produto.estoque -= qtd;

  const novoPedido = {
    id: gerarId('pedidos'),
    compradorId: comprador.id,
    produtoId: produto.id,
    quantidade: qtd,
    // "Retrato" do momento da compra: se o preço mudar depois, o pedido mantém o valor pago.
    precoUnitario: produto.preco,
    valorTotal: arredondar(produto.preco * qtd),
    data: new Date().toISOString(),
  };

  db.pedidos.push(novoPedido);
  res.status(201).json(novoPedido);
});

// Listar pedidos (filtro opcional: /pedidos?compradorId=2)
app.get('/pedidos', (req, res) => {
  const { compradorId } = req.query;
  const id = compradorId !== undefined ? paraId(compradorId) : null;
  const lista =
    compradorId !== undefined
      ? db.pedidos.filter((p) => p.compradorId === id)
      : db.pedidos;
  res.json(lista);
});

// Buscar pedido por id
app.get('/pedidos/:id', (req, res) => {
  const pedido = db.pedidos.find((p) => p.id === paraId(req.params.id));
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  res.json(pedido);
});

// ---------------------------------------------------------------------------
// 4. Visão geral do sistema
// ---------------------------------------------------------------------------
app.get('/resumo', (req, res) => {
  const faturamentoTotal = arredondar(
    db.pedidos.reduce((soma, p) => soma + p.valorTotal, 0),
  );

  res.json({
    usuarios: {
      total: db.usuarios.length,
      vendedores: db.usuarios.filter((u) => u.tipo === 'vendedor').length,
      compradores: db.usuarios.filter((u) => u.tipo === 'comprador').length,
    },
    produtos: {
      total: db.produtos.length,
      naVitrine: db.produtos.filter((p) => p.estoque > 0).length,
      semEstoque: db.produtos.filter((p) => p.estoque === 0).length,
    },
    pedidos: {
      total: db.pedidos.length,
      itensVendidos: db.pedidos.reduce((soma, p) => soma + p.quantidade, 0),
      faturamentoTotal,
    },
  });
});

// ---------------------------------------------------------------------------
// Tratamento de rotas inexistentes e erros
// ---------------------------------------------------------------------------

// Rota não cadastrada: responde em JSON em vez da página HTML padrão do Express
app.use((req, res) => {
  res.status(404).json({ erro: `Rota ${req.method} ${req.originalUrl} não encontrada.` });
});

// JSON malformado no corpo da requisição ou erro inesperado
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: 'JSON inválido no corpo da requisição.' });
  }
  console.error(err);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

// ---------------------------------------------------------------------------
// Inicia o servidor
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Marketplace rodando em http://localhost:${PORT}`);
});
