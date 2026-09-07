---
title: GPT-6 Astra
description: Native Codex and OpenAI API Astra routing in this fork.
---

## Codex-login route

Select the bare `gpt-6-astra` model to use the existing OpenAI/Codex login route. Its catalog entry comes from Astra's own pinned Codex model definition, not a copy of Sol's capabilities. The entry preserves the native `low` default, six reasoning levels through `ultra`, and the model's tool and multi-agent metadata. A client which cannot accept newer reasoning levels can still apply the existing compatibility clamp.

The default native window is 272,000 tokens. An explicit OpenAI provider context cap or per-model window can opt Astra into a larger window, but never beyond its 872,000-token native ceiling. The resolved input limit cannot exceed the selected window. Existing policy for the other native models is unchanged.

For example, add the following model-window setting to an existing canonical Codex-forward `openai` provider:

```json
{
  "modelContextWindows": {
    "gpt-6-astra": 872000
  }
}
```

A smaller `providerContextCaps.openai` still wins as a hard limit. Model visibility and the featured subagent list remain user settings; adding Astra does not rewrite those selections.

## API-key route

`openai-apikey/gpt-6-astra` uses the separate public OpenAI API credential route. It advertises the API's 1,050,000-token window, a 922,000-token input allowance, 128,000-token output limit and `low` through `max` effort ladder. Do not treat the native Codex `ultra` level or native window as the public API contract. Explicit user caps can lower the API limits.

## Cost display

The dollar display is an estimate based on the [OpenAI API model price](https://developers.openai.com/api/docs/models/gpt-6-astra), including the published long-input and Fast multipliers. For the Codex-login route it is explicitly an **API-reference comparison estimate**, not a conversion of subscription credits or a reconstruction of the user's bill. The pricing rule is scoped to the two OpenAI routes and does not reprice resellers using the same model name.

Catalog synchronization repairs the earlier fork-generated Astra placeholder and the old built-in Fast description. Custom display labels, other native models and unrelated provider settings remain untouched.
