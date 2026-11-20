// Desafio Técnico Back-End: Engenharia de Dados com MongoDB
// Parte 3 — Persistência de dados com MongoDB (Mongoose)

require('dotenv').config({ quiet: true });
const express = require('express');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// MODELOS (SCHEMAS)
// ---------------------------------------------------------------------------

const UsuarioSchema = new mongoose.Schema(
  {
    nome: { type: String, required: true, trim: true, minlength: 1 },
    tipo: { type: String, enum: ['vendedor', 'comprador'], required: true },
  },
  { timestamps: true },
);
const Usuario = mongoose.model('Usuario', UsuarioSchema);

const ProdutoSchema = new mongoose.Schema(
  {
    vendedorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', required: true },
    nome: { type: String, required: true, trim: true, minlength: 1 },
    preco: { type: Number, required: true, min: [0.01, 'O preço deve ser maior que zero.'] },
    estoque: {
      type: Number,
      required: true,
      min: [0, 'O estoque não pode ser negativo.'],
      validate: { validator: Number.isInteger, message: 'O estoque deve ser um número inteiro.' },
    },
  },
  { timestamps: true },
);
// Índice para a vitrine, que filtra por estoque > 0
ProdutoSchema.index({ estoque: 1 });
const Produto = mongoose.model('Produto', ProdutoSchema);

const PedidoSchema = new mongoose.Schema({
  compradorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', required: true },
  produtoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Produto', required: true },
  quantidade: {
    type: Number,
    required: true,
    min: [1, 'A quantidade deve ser maior que zero.'],
    validate: { validator: Number.isInteger, message: 'A quantidade deve ser um número inteiro.' },
  },
  // "Retrato" do momento da compra: se o preço do produto mudar, o pedido mantém o valor pago
  precoUnitario: { type: Number, required: true },
  valorTotal: { type: Number, required: true },
  data: { type: Date, default: Date.now },
});
// Índice para listar os pedidos de um comprador (GET /pedidos?compradorId=...)
PedidoSchema.index({ compradorId: 1, data: -1 });
const Pedido = mongoose.model('Pedido', PedidoSchema);

// ---------------------------------------------------------------------------
// FUNÇÕES AUXILIARES
// ---------------------------------------------------------------------------

// Evita resíduos de ponto flutuante (ex.: 0.1 * 3 = 0.30000000000000004)
const arredondar = (valor) => Math.round(valor * 100) / 100;

// Um ObjectId válido tem exatamente 24 caracteres hexadecimais
const idValido = (id) => typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id);

const inteiroPositivo = (valor) => {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Envolve rotas assíncronas: qualquer erro vai para o middleware de erros no final do arquivo
const rota = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------------------------------------------------------------------------
// ROTAS — USUÁRIOS
// ---------------------------------------------------------------------------

// 1. Cadastrar usuário
app.post('/usuarios', rota(async (req, res) => {
  const { nome, tipo } = req.body ?? {};
  const novoUsuario = await Usuario.create({ nome, tipo });
  res.status(201).json(novoUsuario);
}));

// Listar usuários (filtro opcional: /usuarios?tipo=vendedor)
app.get('/usuarios', rota(async (req, res) => {
  const filtro = req.query.tipo ? { tipo: req.query.tipo } : {};
  res.json(await Usuario.find(filtro).sort({ createdAt: 1 }));
}));

// Buscar usuário por id
app.get('/usuarios/:id', rota(async (req, res) => {
  if (!idValido(req.params.id)) return res.status(400).json({ erro: 'Id inválido.' });
  const usuario = await Usuario.findById(req.params.id);
  if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  res.json(usuario);
}));

// ---------------------------------------------------------------------------
// ROTAS — PRODUTOS
// ---------------------------------------------------------------------------

// 2. Anunciar produto (apenas vendedores)
app.post('/produtos', rota(async (req, res) => {
  const { vendedorId, nome, preco, estoque } = req.body ?? {};

  if (!idValido(vendedorId)) {
    return res.status(400).json({ erro: 'Informe um vendedorId válido.' });
  }

  const usuario = await Usuario.findById(vendedorId);
  if (!usuario) return res.status(404).json({ erro: 'Vendedor não encontrado.' });
  if (usuario.tipo !== 'vendedor') {
    return res.status(403).json({ erro: 'Apenas usuários do tipo vendedor podem anunciar produtos.' });
  }

  const novoProduto = await Produto.create({
    vendedorId,
    nome,
    preco: preco === undefined ? undefined : arredondar(Number(preco)),
    estoque,
  });
  res.status(201).json(novoProduto);
}));

// 3. Listar vitrine (traz o nome do vendedor com populate)
app.get('/produtos', rota(async (req, res) => {
  const disponiveis = await Produto.find({ estoque: { $gt: 0 } })
    .populate('vendedorId', 'nome') // mostra o nome da loja em vez de apenas o id
    .sort({ nome: 1 });
  res.json(disponiveis);
}));

// Buscar produto por id (inclusive sem estoque)
app.get('/produtos/:id', rota(async (req, res) => {
  if (!idValido(req.params.id)) return res.status(400).json({ erro: 'Id inválido.' });
  const produto = await Produto.findById(req.params.id).populate('vendedorId', 'nome');
  if (!produto) return res.status(404).json({ erro: 'Produto não encontrado.' });
  res.json(produto);
}));

// ---------------------------------------------------------------------------
// ROTAS — PEDIDOS
// ---------------------------------------------------------------------------

// 4. Realizar compra (apenas compradores)
app.post('/pedidos', rota(async (req, res) => {
  const { compradorId, produtoId, quantidade } = req.body ?? {};

  if (!idValido(compradorId) || !idValido(produtoId)) {
    return res.status(400).json({ erro: 'Informe compradorId e produtoId válidos.' });
  }

  // Sem esta validação, quantidade negativa aumentaria o estoque
  const qtd = inteiroPositivo(quantidade);
  if (qtd === null) {
    return res.status(400).json({ erro: 'Informe uma quantidade inteira maior que zero.' });
  }

  const comprador = await Usuario.findById(compradorId);
  if (!comprador) return res.status(404).json({ erro: 'Comprador não encontrado.' });
  if (comprador.tipo !== 'comprador') {
    return res.status(403).json({ erro: 'Apenas usuários do tipo comprador podem realizar pedidos.' });
  }

  // Baixa de estoque ATÔMICA: a verificação (estoque >= qtd) e o desconto ($inc) acontecem
  // na mesma operação do banco. Duas compras simultâneas não conseguem vender o mesmo estoque,
  // o que poderia acontecer com o padrão "ler o produto -> subtrair -> save()".
  const produto = await Produto.findOneAndUpdate(
    { _id: produtoId, estoque: { $gte: qtd } },
    { $inc: { estoque: -qtd } },
    { returnDocument: 'after' }, // devolve o produto já com o estoque atualizado
  );

  if (!produto) {
    // Nada foi atualizado: o produto não existe ou o estoque é insuficiente
    const existente = await Produto.findById(produtoId);
    if (!existente) return res.status(404).json({ erro: 'Produto não encontrado.' });
    return res.status(400).json({
      erro: 'Estoque insuficiente.',
      estoqueDisponivel: existente.estoque,
    });
  }

  try {
    const novoPedido = await Pedido.create({
      compradorId,
      produtoId,
      quantidade: qtd,
      precoUnitario: produto.preco,
      valorTotal: arredondar(produto.preco * qtd),
    });
    res.status(201).json(novoPedido);
  } catch (erro) {
    // Compensação: se o pedido não puder ser gravado, devolve o estoque já descontado.
    // (Uma transação ACID completa exige replica set e é tratada na Tarefa 4.)
    await Produto.updateOne({ _id: produtoId }, { $inc: { estoque: qtd } });
    throw erro;
  }
}));

// Listar pedidos (filtro opcional: /pedidos?compradorId=...)
app.get('/pedidos', rota(async (req, res) => {
  const { compradorId } = req.query;
  if (compradorId !== undefined && !idValido(compradorId)) {
    return res.status(400).json({ erro: 'compradorId inválido.' });
  }
  const filtro = compradorId ? { compradorId } : {};
  const pedidos = await Pedido.find(filtro)
    .populate('compradorId', 'nome')
    .populate('produtoId', 'nome')
    .sort({ data: -1 });
  res.json(pedidos);
}));

// Buscar pedido por id
app.get('/pedidos/:id', rota(async (req, res) => {
  if (!idValido(req.params.id)) return res.status(400).json({ erro: 'Id inválido.' });
  const pedido = await Pedido.findById(req.params.id)
    .populate('compradorId', 'nome')
    .populate('produtoId', 'nome');
  if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });
  res.json(pedido);
}));

// ---------------------------------------------------------------------------
// VISÃO GERAL DO SISTEMA (cálculos feitos no banco)
// ---------------------------------------------------------------------------
app.get('/resumo', rota(async (req, res) => {
  const [vendedores, compradores, totalProdutos, naVitrine, vendas] = await Promise.all([
    Usuario.countDocuments({ tipo: 'vendedor' }),
    Usuario.countDocuments({ tipo: 'comprador' }),
    Produto.countDocuments(),
    Produto.countDocuments({ estoque: { $gt: 0 } }),
    Pedido.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          itensVendidos: { $sum: '$quantidade' },
          faturamentoTotal: { $sum: '$valorTotal' },
        },
      },
    ]),
  ]);

  const v = vendas[0] ?? { total: 0, itensVendidos: 0, faturamentoTotal: 0 };

  res.json({
    usuarios: { total: vendedores + compradores, vendedores, compradores },
    produtos: { total: totalProdutos, naVitrine, semEstoque: totalProdutos - naVitrine },
    pedidos: {
      total: v.total,
      itensVendidos: v.itensVendidos,
      faturamentoTotal: arredondar(v.faturamentoTotal),
    },
  });
}));

// ---------------------------------------------------------------------------
// TRATAMENTO DE ROTAS INEXISTENTES E ERROS
// ---------------------------------------------------------------------------

app.use((req, res) => {
  res.status(404).json({ erro: `Rota ${req.method} ${req.originalUrl} não encontrada.` });
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: 'JSON inválido no corpo da requisição.' });
  }
  if (err instanceof mongoose.Error.ValidationError) {
    return res.status(400).json({
      erro: 'Dados inválidos.',
      detalhes: Object.values(err.errors).map((e) => e.message),
    });
  }
  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ erro: `Valor inválido para o campo ${err.path}.` });
  }
  console.error(err);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

// ---------------------------------------------------------------------------
// CONEXÃO COM O MONGODB E INÍCIO DO SERVIDOR
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

async function iniciar() {
  if (!MONGO_URI) {
    console.error('Variável MONGO_URI não definida. Crie o arquivo .env (veja o .env.example).');
    process.exit(1);
  }

  try {
    // O servidor só começa a aceitar requisições depois que o banco está conectado
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('Conectado ao MongoDB com sucesso!');

    app.listen(PORT, () => {
      console.log(`Marketplace rodando em http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Erro ao conectar ao MongoDB:', err.message);
    process.exit(1);
  }
}

iniciar();
