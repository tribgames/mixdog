# The smallest model the embedding worker and the Rust embedder both load for real: `last_hidden_state[0, t, k] =
# (input_ids[t] + 1) * (k + 1)`, 384 wide (the default model's dimensions), with a Unigram tokenizer the two tokenizers
# accept. Written into `<out>/` as the model directory's files (`onnx/model_quantized.onnx`, `tokenizer.json`,
# `tokenizer_config.json`).
#
#   python tiny-embedding-model.py <out>     (needs the `onnx` package)
import json
import os
import sys

import onnx
from onnx import TensorProto, helper

out = sys.argv[1]
os.makedirs(os.path.join(out, "onnx"), exist_ok=True)
width = 384
nodes = [
    helper.make_node("Cast", ["input_ids"], ["ids"], to=TensorProto.FLOAT),
    helper.make_node("Add", ["ids", "one"], ["shifted"]),
    helper.make_node("Unsqueeze", ["shifted", "axis"], ["column"]),
    helper.make_node("Mul", ["column", "scale"], ["last_hidden_state"]),
]
graph = helper.make_graph(
    nodes,
    "tiny-embedding",
    [
        helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, "n"]),
        helper.make_tensor_value_info("attention_mask", TensorProto.INT64, [1, "n"]),
    ],
    [helper.make_tensor_value_info("last_hidden_state", TensorProto.FLOAT, [1, "n", width])],
    [
        helper.make_tensor("one", TensorProto.FLOAT, [], [1.0]),
        helper.make_tensor("axis", TensorProto.INT64, [1], [2]),
        helper.make_tensor("scale", TensorProto.FLOAT, [1, 1, width], [float(k + 1) for k in range(width)]),
    ],
)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], ir_version=8)
onnx.checker.check_model(model)
onnx.save(model, os.path.join(out, "onnx", "model_quantized.onnx"))

vocab = [["<s>", 0.0], ["<pad>", 0.0], ["</s>", 0.0], ["<unk>", 0.0], ["\u2581", -1.0]]
vocab += [[c, -2.0] for c in "abcdefghijklmnopqrstuvwxyz"]
tokenizer = {
    "added_tokens": [
        {"id": i, "content": t, "single_word": False, "lstrip": False, "rstrip": False, "normalized": False, "special": True}
        for i, t in enumerate(["<s>", "<pad>", "</s>", "<unk>"])
    ],
    "normalizer": None,
    "pre_tokenizer": {"type": "Metaspace", "replacement": "\u2581", "prepend_scheme": "always", "split": True},
    "post_processor": {
        "type": "TemplateProcessing",
        "single": [{"SpecialToken": {"id": "<s>", "type_id": 0}}, {"Sequence": {"id": "A", "type_id": 0}}, {"SpecialToken": {"id": "</s>", "type_id": 0}}],
        "pair": [],
        "special_tokens": {"<s>": {"id": "<s>", "ids": [0], "tokens": ["<s>"]}, "</s>": {"id": "</s>", "ids": [2], "tokens": ["</s>"]}},
    },
    "model": {"type": "Unigram", "unk_id": 3, "vocab": vocab, "byte_fallback": False},
}
with open(os.path.join(out, "tokenizer.json"), "w", encoding="utf-8") as f:
    json.dump(tokenizer, f, ensure_ascii=False)
with open(os.path.join(out, "tokenizer_config.json"), "w", encoding="utf-8") as f:
    json.dump({"model_max_length": 512}, f)
