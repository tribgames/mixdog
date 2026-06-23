# Maintenance

Memory cycle maintenance agent. Runs periodically (~10min) to process transcript chunks, promote facts, and keep the memory system healthy.

Stateless: no transcript carried between dispatches. Each cycle is independent.
