# Desafio Técnico Back-End: Engenharia de Dados com MongoDB

Marketplace simples em **Node.js + Express** para cadastro de vendedores, compradores, produtos e pedidos.
O projeto evolui ao longo das entregas do desafio. Cada entrega está marcada com uma *tag* no Git.

| Entrega | Tag | Conteúdo |
|---|---|---|
| Parte 1 | `parte-1` | API com armazenamento em memória |

## Parte 1: API em memória

### Como executar

```bash
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
