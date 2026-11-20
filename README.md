# Desafio Técnico Back-End: Engenharia de Dados com MongoDB

Marketplace simples em **Node.js + Express** para cadastro de vendedores, compradores, produtos e pedidos.
O projeto evolui ao longo das entregas do desafio. Cada entrega está marcada com uma *tag* no Git.

| Entrega | Tag | Conteúdo |
|---|---|---|
| Parte 1 | `parte-1` | API com armazenamento em memória |
| Parte 2 | `parte-2` | Testes da API no Insomnia (`docs/parte-2`) |
| Parte 3 | `parte-3` | Persistência com MongoDB (Mongoose) |
| Parte 4 | `parte-4` | Script de seed (1.000 produtos, 5.000 usuários, 100.000 pedidos) |

## Parte 4: script de seed

Gera uma base de teste com **1.000 produtos, 5.000 usuários e 100.000 pedidos** usando `insertMany` em lotes de 10.000.
As coleções ficam propositalmente **sem índices secundários** (a otimização é feita na Tarefa 3).

### Pré-requisito: replica set

A URI usa `?replicaSet=rs0`, necessário para as transações da Tarefa 4. Para transformar um MongoDB local em replica set de um nó:

1. No `mongod.cfg`, adicione:
   ```yaml
   replication:
     replSetName: rs0
   ```
2. Reinicie o serviço do MongoDB.
3. No `mongosh`: `rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "localhost:27017" }] })`

### Como executar

```bash
npm install
npm run seed      # gera os dados no banco marketplace_seed
npm run amostra   # exibe a amostra do banco e salva em docs/parte-4/amostra.txt
```

### Ajustes em relação ao script de referência

- **Banco separado (`marketplace_seed`):** o seed executa `dropDatabase()`. Com o nome `marketplace` do exemplo, ele apagaria os dados da API da Parte 3. Há uma trava que impede o uso desse nome.
- **URI e banco configuráveis** pelo `.env` (`SEED_MONGO_URI`, `SEED_DB_NAME`), com valores padrão.
- **Conferência final:** tempo de execução e contagem de documentos por coleção.
- **Mensagem de ajuda** quando o MongoDB ou o replica set não estão disponíveis.

## Parte 3: persistência com MongoDB

A partir da Parte 3, o `index.js` usa **MongoDB com Mongoose**. A versão em memória continua disponível na tag `parte-1`.

### Como executar

1. Tenha o MongoDB rodando localmente (ou um cluster no MongoDB Atlas).
2. Copie `.env.example` para `.env` e ajuste a `MONGO_URI`, se necessário.
3. Instale e inicie:

```bash
npm install
node index.js
```

As rotas são as mesmas da Parte 1. A diferença é que os ids passam a ser `ObjectId` do MongoDB (ex.: `"674e1f2a9b3c4d5e6f708192"`), e não `1`, `2`.

### Melhorias em relação ao exemplo de referência

- **Baixa de estoque atômica:** `findOneAndUpdate({ _id, estoque: { $gte: qtd } }, { $inc: { estoque: -qtd } })`. A verificação e o desconto acontecem numa única operação, então duas compras simultâneas não vendem o mesmo estoque (o exemplo lia, subtraía e chamava `save()`).
- **Compensação de estoque:** se a gravação do pedido falhar, o estoque descontado é devolvido.
- **Servidor só sobe após conectar ao banco:** no exemplo, a API aceitava requisições mesmo sem conexão, e elas ficavam travadas até dar erro.
- **Validações no schema:** preço maior que zero, estoque e quantidade inteiros e não negativos, nome obrigatório.
- **Ids validados antes da consulta:** um id malformado retorna `400`, e não um erro genérico.
- **Pedido guarda `precoUnitario`**, e o `/resumo` calcula os totais no banco (`countDocuments` e `aggregate`).
- **Índices** em `produtos.estoque` (vitrine) e `pedidos.compradorId + data` (pedidos por comprador).
- **`.env` fora do Git:** a URI pode conter usuário e senha. O repositório traz um `.env.example`.

## Parte 1: API em memória (tag `parte-1`)

### Como executar

```bash
git checkout parte-1
npm install
node index.js
```

O servidor sobe em `http://localhost:3000`.

### Rotas

| Método | Rota | Descrição |
|---|---|---|
| POST | `/usuarios` | Cadastra usuário (`nome`, `tipo`: `vendedor` ou `comprador`) |
| GET | `/usuarios` | Lista usuários (filtro opcional `?tipo=vendedor`) |
| GET | `/usuarios/:id` | Busca usuário por id |
| POST | `/produtos` | Anuncia produto (`vendedorId`, `nome`, `preco`, `estoque`). Apenas vendedores |
| GET | `/produtos` | Vitrine: produtos com estoque disponível |
| GET | `/produtos/:id` | Busca produto por id (inclusive sem estoque) |
| POST | `/pedidos` | Realiza compra (`compradorId`, `produtoId`, `quantidade`). Apenas compradores |
| GET | `/pedidos` | Lista pedidos (filtro opcional `?compradorId=2`) |
| GET | `/pedidos/:id` | Busca pedido por id |
| GET | `/resumo` | Visão geral: totais de usuários, produtos, pedidos e faturamento |

### Melhorias em relação ao exemplo de referência

- **Validação de `quantidade`:** no exemplo, um pedido sem `quantidade` transformava o estoque em `NaN` e uma quantidade negativa aumentava o estoque.
- **Validação de produto:** nome obrigatório, preço maior que zero e estoque inteiro não negativo (antes `preco: "abc"` virava `NaN`).
- **IDs aceitos como número ou texto:** `1` e `"1"` são tratados igualmente, evitando um 403 enganoso.
- **IDs com contador próprio:** `array.length + 1` geraria IDs repetidos caso registros fossem removidos.
- **Preço unitário no pedido (`precoUnitario`):** o pedido guarda o preço do momento da compra, mesmo que o produto mude de preço depois.
- **Valores arredondados em 2 casas:** evita resíduos de ponto flutuante (ex.: `0.1 * 3`).
- **Status HTTP mais precisos:** `404` quando o registro não existe e `403` quando o usuário existe mas é do tipo errado.
- **Respostas de erro sempre em JSON:** inclusive para rota inexistente e JSON malformado.
- **Rotas de consulta e `/resumo`:** permitem acompanhar o estado do sistema (visão geral).
