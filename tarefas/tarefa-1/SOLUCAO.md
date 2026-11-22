# Tarefa 1: Modelagem e Evolução de Schema

**Desafio Técnico Back-End: Engenharia de Dados com MongoDB**
Luka Gomes · Desenvolvimento de Software Multiplataforma · FATEC Jacareí · 20/11/2026

---

## 1. Contexto

A modelagem parte das coleções que já existem no banco `marketplace_seed` (Parte 4):

| Coleção | Documentos | Observação |
|---|---|---|
| `products` | 1.000 | `sku`, `name`, `category`, `price`, `stock`, `sellerId`, `active` |
| `users` | 5.000 | `name`, `email`, `city`, `walletBalance`, `createdAt` |
| `orders` | 100.000 | `userId`, `shippingCity`, `status`, `items[]` embutidos, `totalAmount`, `createdAt` |

A área de produto quer lançar duas funcionalidades:

1. **Avaliações de produtos:** nota de 1 a 5, comentário, data e autor. Um produto popular pode receber **dezenas de milhares** de avaliações. A tela do produto deve mostrar a **média**, o **total** e as **10 avaliações mais recentes** sem consultas pesadas.
2. **Auditoria de pedidos:** guardar o histórico de mudanças de status (`PENDING → PAID → SHIPPED → DELIVERED`), com status, data e usuário responsável.

A regra usada para decidir entre **Embedding** (embutir) e **Referencing** (referenciar) foi:

> **Embutir** o que é lido junto com o documento pai e tem **tamanho limitado**.
> **Referenciar** o que **cresce sem limite** ou precisa ser consultado de forma independente.

---

## 2. Resumo das decisões

| Dado | Estratégia | Onde fica | Motivo |
|---|---|---|---|
| Todas as avaliações | **Referencing** | Coleção nova `reviews` | Cresce sem limite (dezenas de milhares por produto) |
| Média, total e distribuição das notas | **Embedding** (*Computed Pattern*) | `products.ratingSummary` | Valores pré-calculados: a tela não agrega nada |
| 10 avaliações mais recentes | **Embedding** (*Subset Pattern*) | `products.recentReviews` | Array **limitado a 10** itens, lido junto com o produto |
| Autor da avaliação | **Referência + cópia do nome** (*Extended Reference*) | `reviews.author` | Exibe o nome sem `$lookup` em `users` |
| Histórico de status do pedido | **Embedding** | `orders.statusHistory` | Ciclo de vida finito (poucas transições), lido junto com o pedido |
| Responsável pela mudança | **Referência + cópia do nome e papel** | `statusHistory[].changedBy` | A auditoria registra quem era no momento, mesmo que o usuário mude depois |

---

## 3. Funcionalidade 1: avaliações de produtos

### 3.1 Coleção `reviews` (Referencing)

Cada avaliação é **um documento próprio**, que referencia o produto e o autor:

```json
{
  "_id": { "$oid": "6741a0c2e4b0f1a2b3c4d5e6" },
  "productId": { "$oid": "6b00d95bc3c0f2954a9cbaab" },
  "author": {
    "userId": { "$oid": "6b00d95bc3c0f2954a9cbe93" },
    "name": "Cliente 1"
  },
  "rating": 5,
  "comment": "Produto excelente, chegou antes do prazo.",
  "createdAt": { "$date": "2026-11-20T21:15:00Z" },
  "schemaVersion": 1
}
```

- **`productId`** e **`author.userId`** são referências (*Referencing*).
- **`author.name`** é uma cópia do nome (*Extended Reference*): a listagem de avaliações mostra o autor sem consultar a coleção `users`.

**Índices:**

```js
// Listar as avaliações de um produto, das mais recentes para as mais antigas (paginação)
db.reviews.createIndex({ productId: 1, createdAt: -1 })

// Regra de negócio: cada usuário avalia um produto uma única vez
db.reviews.createIndex({ productId: 1, "author.userId": 1 }, { unique: true })
```

**Validação no banco** (garante nota inteira de 1 a 5 e comentário limitado):

```js
db.createCollection("reviews", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["productId", "author", "rating", "createdAt"],
      properties: {
        rating:  { bsonType: "int", minimum: 1, maximum: 5 },
        comment: { bsonType: "string", maxLength: 2000 },
        author:  { bsonType: "object", required: ["userId", "name"] }
      }
    }
  }
})
```

### 3.2 Coleção `products` evoluída (Embedding)

O produto ganha dois campos novos: um **resumo pré-calculado** e um **subconjunto limitado** das avaliações.

```json
{
  "_id": { "$oid": "6b00d95bc3c0f2954a9cbaab" },
  "sku": "SKU-00001",
  "name": "Produto Exemplo 1",
  "category": "Casa e Cozinha",
  "price": 228.93,
  "stock": 248,
  "sellerId": "SELLER-2",
  "active": true,

  "ratingSummary": {
    "count": 18452,
    "sum": 79342,
    "average": 4.3,
    "distribution": { "1": 410, "2": 655, "3": 1980, "4": 5120, "5": 10287 }
  },

  "recentReviews": [
    {
      "reviewId": { "$oid": "6741a0c2e4b0f1a2b3c4d5e6" },
      "author": { "userId": { "$oid": "6b00d95bc3c0f2954a9cbe93" }, "name": "Cliente 1" },
      "rating": 5,
      "comment": "Produto excelente, chegou antes do prazo.",
      "createdAt": { "$date": "2026-11-20T21:15:00Z" }
    }
    // ... no máximo 10 itens, do mais recente para o mais antigo
  ],

  "schemaVersion": 2
}
```

- **`ratingSummary`** (*Computed Pattern*): o total e a soma são atualizados a cada nova avaliação, e a média é calculada no momento da escrita. A tela **lê** os valores prontos em vez de rodar um `$group` sobre milhares de avaliações a cada visita. A `distribution` permite mostrar as barras de "quantas avaliações de 5, 4, 3… estrelas" sem custo extra.
- **`recentReviews`** (*Subset Pattern*): cópia das **10 avaliações mais recentes**. As demais ficam apenas na coleção `reviews`.

### 3.3 Escrita: cadastrar uma avaliação

Duas operações, executadas na **mesma transação** para que o resumo nunca fique diferente da coleção `reviews` (o banco já roda como replica set, requisito para transações):

```js
const session = client.startSession();
await session.withTransaction(async () => {
  const review = {
    _id: new ObjectId(),
    productId,
    author: { userId, name: userName },
    rating,                       // inteiro de 1 a 5
    comment,
    createdAt: new Date(),
    schemaVersion: 1,
  };

  // 1) Grava a avaliação completa na coleção própria (Referencing)
  await db.collection("reviews").insertOne(review, { session });

  // 2) Atualiza o produto numa única operação atômica (pipeline de atualização)
  await db.collection("products").updateOne(
    { _id: productId },
    [
      {
        $set: {
          "ratingSummary.count": { $add: [{ $ifNull: ["$ratingSummary.count", 0] }, 1] },
          "ratingSummary.sum":   { $add: [{ $ifNull: ["$ratingSummary.sum", 0] }, rating] },
          [`ratingSummary.distribution.${rating}`]: {
            $add: [{ $ifNull: [`$ratingSummary.distribution.${rating}`, 0] }, 1],
          },
          // Mantém só as 10 mais recentes: a nova entra no início e o array é cortado
          recentReviews: {
            $slice: [
              { $concatArrays: [[{ $literal: {   // $literal: um comentário iniciado com "$"
                  reviewId: review._id,           // não é interpretado como campo
                  author: review.author, rating,
                  comment: review.comment, createdAt: review.createdAt,
              } }], { $ifNull: ["$recentReviews", []] }] },
              10,
            ],
          },
        },
      },
      // Recalcula a média a partir dos valores já atualizados
      { $set: { "ratingSummary.average": {
          $round: [{ $divide: ["$ratingSummary.sum", "$ratingSummary.count"] }, 1],
      } } },
    ],
    { session },
  );
});
```

**Edição ou exclusão de uma avaliação:** o resumo é ajustado com os valores inversos (por exemplo, `count - 1` e `sum - notaAntiga`). Se a avaliação estiver em `recentReviews`, ela é removida (`$pull`) e o array é completado com a próxima mais recente, buscada pelo índice `{ productId, createdAt }`.

### 3.4 Leitura: tela do produto

**Uma única consulta, por `_id`**, traz tudo o que a tela precisa:

```js
db.products.findOne(
  { _id: productId },
  { name: 1, price: 1, stock: 1, category: 1, ratingSummary: 1, recentReviews: 1 }
)
```

- Média → `ratingSummary.average`
- Total → `ratingSummary.count`
- 10 mais recentes → `recentReviews` (já em ordem)

Não há `$lookup`, `$group` nem varredura da coleção `reviews`. A busca usa o índice `_id`, e o custo é o mesmo com 10 ou 50.000 avaliações.

**"Ver todas as avaliações"** (página secundária): consulta paginada na coleção `reviews`, coberta pelo índice `{ productId: 1, createdAt: -1 }`. A paginação usa a data da última avaliação exibida, e não `skip`, que fica mais lento a cada página:

```js
db.reviews
  .find({ productId, createdAt: { $lt: ultimaDataDaPaginaAnterior } })
  .sort({ createdAt: -1 })
  .limit(20)
```

---

## 4. Funcionalidade 2: auditoria de pedidos

### 4.1 Coleção `orders` evoluída (Embedding)

O histórico fica **embutido no próprio pedido**, no array `statusHistory`. O campo `status` continua existindo com o status atual, então as consultas e índices atuais (como os das Tarefas 2 e 3) não mudam.

```json
{
  "_id": { "$oid": "6b00d95bc3c0f2954a9cd21b" },
  "userId": { "$oid": "6b00d95bc3c0f2954a9cd15b" },
  "shippingCity": "Rio de Janeiro",
  "status": "DELIVERED",
  "items": [
    { "productId": { "$oid": "6b00d95bc3c0f2954a9cbdbe" }, "sku": "SKU-00788",
      "category": "Livros", "unitPrice": 148.59, "quantity": 1 }
  ],
  "totalAmount": 148.59,
  "createdAt": { "$date": "2026-11-10T14:02:00Z" },

  "statusHistory": [
    { "from": null,      "to": "PENDING",   "changedAt": { "$date": "2026-11-10T14:02:00Z" },
      "changedBy": { "userId": { "$oid": "6b00d95bc3c0f2954a9cd15b" }, "name": "Cliente 7", "role": "customer" } },
    { "from": "PENDING", "to": "PAID",      "changedAt": { "$date": "2026-11-10T14:03:12Z" },
      "changedBy": { "userId": null, "name": "Gateway de pagamento", "role": "system" } },
    { "from": "PAID",    "to": "SHIPPED",   "changedAt": { "$date": "2026-11-11T09:30:00Z" },
      "changedBy": { "userId": { "$oid": "6741b1d3e4b0f1a2b3c4d5f7" }, "name": "Ana Souza", "role": "operator" } },
    { "from": "SHIPPED", "to": "DELIVERED", "changedAt": { "$date": "2026-11-13T16:45:00Z" },
      "changedBy": { "userId": null, "name": "Integração transportadora", "role": "system" } }
  ],

  "schemaVersion": 2
}
```

- **`from` / `to`:** registram a transição completa, e não só o novo status.
- **`changedBy`:** guarda a referência ao usuário **e uma cópia do nome e do papel** (*Extended Reference*). Numa auditoria, interessa quem era o responsável **no momento** da mudança, mesmo que o usuário seja renomeado ou removido depois. Mudanças automáticas são registradas com `role: "system"`.

### 4.2 Por que embutir aqui

- **O histórico é naturalmente limitado:** o ciclo de vida de um pedido tem poucas transições (4 no fluxo normal, mais alguma exceção como `CANCELED`). Cada entrada tem cerca de 150 bytes, então o histórico de um pedido fica abaixo de 1 KB.
- **É lido junto com o pedido:** a tela de detalhes mostra o pedido e sua linha do tempo numa única leitura, sem `$lookup`.
- **A atualização é atômica:** o status atual e o histórico mudam no mesmo comando, num único documento. Não existe o risco de o status mudar sem que o histórico seja gravado.

### 4.3 Escrita: mudar o status de um pedido

```js
db.orders.updateOne(
  { _id: orderId, status: "PAID" },          // só avança se o status atual for o esperado
  {
    $set:  { status: "SHIPPED" },
    $push: { statusHistory: {
      from: "PAID", to: "SHIPPED", changedAt: new Date(),
      changedBy: { userId: operadorId, name: "Ana Souza", role: "operator" },
    } },
  }
)
```

O filtro `status: "PAID"` impede transições inválidas e mudanças simultâneas conflitantes: se outro processo já tiver alterado o status, `matchedCount` volta 0 e nada é gravado.

### 4.4 Proteção contra crescimento indevido

Mesmo sendo limitado pela regra de negócio, o array recebe um teto explícito na validação da coleção. Assim, um bug que gere mudanças em loop não consegue fazer o documento crescer sem limite:

```js
db.runCommand({
  collMod: "orders",
  validator: { $jsonSchema: { properties: {
    statusHistory: { bsonType: "array", maxItems: 20 }
  } } },
  validationLevel: "moderate"   // valida inserções e documentos já migrados
})
```

### 4.5 Quando valeria usar uma coleção separada

Se o requisito mudasse para registrar **qualquer alteração** do pedido (endereço, itens, cada tentativa de entrega, eventos de sistema), o histórico deixaria de ser limitado. Também seria o caso se a auditoria precisasse de **retenção e imutabilidade** independentes do pedido, ou de consultas transversais frequentes como "todas as ações do operador X no mês". Nesses cenários, o certo seria uma coleção `order_events` (Referencing), indexada por `{ orderId: 1, changedAt: 1 }` e por `{ "changedBy.userId": 1, changedAt: -1 }`. Para o requisito atual (histórico de **status**), embutir é a opção mais simples e mais rápida.

---

## 5. Como a modelagem evita o antipadrão de Unbounded Arrays

Um documento do MongoDB tem **limite de 16 MB**. O antipadrão *Unbounded Arrays* acontece quando um array dentro do documento cresce sem limite.

**O que aconteceria embutindo todas as avaliações no produto:**

| Cenário | Tamanho estimado |
|---|---|
| 1 avaliação (ids, nome, nota, comentário médio, data) | ~300 bytes |
| 50.000 avaliações embutidas | ~15 MB, já colado no limite |
| Comentários mais longos (~500 bytes) | o limite de 16 MB é atingido com ~32.000 avaliações |

Mesmo **antes** do limite, os problemas já apareceriam:

- **Leitura cara:** cada visita à tela do produto carregaria megabytes para exibir só 10 avaliações.
- **Escrita cara:** cada nova avaliação reescreve um documento enorme, e o documento cresce sem parar.
- **Memória desperdiçada:** documentos gigantes ocupam o cache do MongoDB (*working set*) e expulsam dados úteis.
- **Contenção:** várias avaliações simultâneas disputam o mesmo documento.

**Como a solução proposta evita isso:**

| Array / campo | Crescimento | Tamanho máximo |
|---|---|---|
| `products.recentReviews` | **Limitado a 10** pelo `$slice` na própria atualização | ~3 KB a ~6 KB |
| `products.ratingSummary` | **Fixo** (só números) | ~150 bytes |
| `orders.statusHistory` | **Limitado** pelo ciclo de vida + `maxItems: 20` | < 3 KB |
| `reviews` | Uma avaliação por **documento**: cresce em quantidade de documentos, nunca em tamanho | ~300 bytes cada |

O volume que cresce sem limite (as avaliações) fica **distribuído em vários documentos pequenos**, e o MongoDB lida muito bem com milhões de documentos. O documento do produto mantém **tamanho praticamente constante**, tenha ele 10 ou 100.000 avaliações.

---

## 6. Como a modelagem garante leitura rápida na tela do produto

| Necessidade da tela | De onde vem | Custo |
|---|---|---|
| Dados do produto | `products` | 1 leitura por `_id` (índice padrão) |
| Média das notas | `ratingSummary.average` (pré-calculada) | 0 extra |
| Total de avaliações | `ratingSummary.count` (pré-calculado) | 0 extra |
| Distribuição por estrela | `ratingSummary.distribution` | 0 extra |
| 10 avaliações mais recentes | `recentReviews` (já ordenadas) | 0 extra |

O custo de manter o resumo é transferido para o momento da **escrita**, que é muito mais rara: um produto é visualizado muitas vezes mais do que é avaliado. É a troca clássica de modelagem orientada a documentos: **modelar pelo padrão de acesso**, otimizando a operação mais frequente.

---

## 7. Evolução do schema (migração dos dados existentes)

Os 1.000 produtos e 100.000 pedidos do seed foram criados **sem** os campos novos. Para evoluir o schema sem quebrar a aplicação, foi usado o padrão **Schema Versioning**: cada documento carrega um `schemaVersion`. Documentos sem o campo são tratados como versão 1, e a aplicação reconhece as duas versões durante a transição.

**Produtos: inicializar o resumo vazio**

```js
db.products.updateMany(
  { schemaVersion: { $exists: false } },
  { $set: {
      ratingSummary: { count: 0, sum: 0, average: null,
                       distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } },
      recentReviews: [],
      schemaVersion: 2,
  } }
)
```

**Pedidos: criar o histórico a partir do status atual**

Os pedidos antigos não têm histórico real. A migração cria um primeiro registro com o status atual e a data de criação, marcado como gerado pela migração. Assim, a auditoria indica de forma honesta que as etapas anteriores não foram registradas.

```js
db.orders.updateMany(
  { schemaVersion: { $exists: false } },
  [ { $set: {
      statusHistory: [ {
        from: null, to: "$status", changedAt: "$createdAt",
        changedBy: { userId: null, name: "Migração de schema v2", role: "system" },
      } ],
      schemaVersion: 2,
  } } ]
)
```

Por ser feita no próprio banco (pipeline de atualização), a migração não traz os 100.000 pedidos para a memória da aplicação. Em produção, ela poderia rodar em lotes (por faixa de `_id`) para não sobrecarregar o servidor. Outra opção seria uma migração "preguiçosa" (*lazy*), em que cada documento é atualizado na primeira vez em que é alterado.

---

## 8. Conclusão

| Requisito | Como foi atendido |
|---|---|
| Avaliações em grande volume | Coleção `reviews` própria (**Referencing**), com um documento por avaliação |
| Média e total sem consultas pesadas | `ratingSummary` pré-calculado (**Computed Pattern**) |
| 10 mais recentes na tela | `recentReviews` limitado a 10 (**Subset Pattern**) |
| Histórico de status do pedido | `statusHistory` embutido (**Embedding**) e atualizado junto com o status |
| Evitar Unbounded Arrays | Nenhum array cresce sem limite: o que é ilimitado vira documentos separados |
| Leitura rápida | A tela do produto é montada com **uma única leitura por `_id`** |
| Evolução do schema | **Schema Versioning** e migração no próprio banco com `updateMany` |
