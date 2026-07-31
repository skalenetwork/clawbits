import asyncio
import json
import os

from google import genai

api_key = os.environ.get("GEMINI_API_KEY")
if not api_key:
    print("Error: GEMINI_API_KEY environment variable is required.")
    exit(1)

client = genai.Client(api_key=api_key)
model_name = "gemma-4-31b-it"

PROMPT_TEMPLATE = """
Generate a synthetic chat thread with 5-10 messages.
Participants: {users}. Subgroups: {subgroups}.
Include typos, interruptions, and implicit addressees.
Crucially, output a 'reasoning' field expressing your Chain-of-Thought BEFORE outputting a 'target_probs' mapping for every message reflecting the conversational context, assigning probabilities across participants, subgroups, or 'global' (must sum to 1.0).
Ensure the 'reasoning' and 'target_probs' are explicitly nested inside a 'metadata' object field for each message, strictly adhering to the following JSON schema requirements:

Required JSON Format:
{{
  "thread_id": "string",
  "persona_map": {{ "user_key": "role string" }},
  "messages": [
    {{
      "msg_id": "string",
      "sender": "string",
      "text": "string",
      "timestamp_offset": 0,
      "metadata": {{
        "reasoning": "string",
        "target_probs": {{ "participant_or_group": 0.0 }}
      }}
    }}
  ]
}}
"""

async def generate_thread(users: list, subgroups: list) -> dict:
    prompt = PROMPT_TEMPLATE.format(users=users, subgroups=subgroups)

    # Notice: Gemma models usually don't support response_mime_type="application/json" config natively,
    # so we rely on the prompt to format the response and we extract it manually.
    response = await asyncio.to_thread(
        client.models.generate_content,
        model=model_name,
        contents=prompt,
    )

    text_content = response.text.strip()

    # Strip potential markdown code blocks like ```json ... ```
    if text_content.startswith("```json"):
        text_content = text_content[7:]
    elif text_content.startswith("```"):
        text_content = text_content[3:]
    if text_content.endswith("```"):
        text_content = text_content[:-3]

    text_content = text_content.strip()

    try:
        return json.loads(text_content)
    except json.JSONDecodeError as e:
        print(f"Failed to parse JSON. Raw output:\n{text_content}\n---")
        raise e

async def synthesize_dataset(num_threads: int = 1000, output_file: str = "synthetic_corpus.json"):
    users = ["Alice", "Bob", "Charlie", "Dave"]
    subgroups = ["Engineering", "Design"]

    sem = asyncio.Semaphore(5)

    async def bounded_generate():
        async with sem:
            return await generate_thread(users, subgroups)

    print(f"Synthesizing {num_threads} threads...")
    tasks = [bounded_generate() for _ in range(num_threads)]
    dataset = await asyncio.gather(*tasks, return_exceptions=True)

    valid_data = []
    for d in dataset:
        if isinstance(d, dict):
            valid_data.append(d)
        else:
            print(f"Error during generation: {d}")

    with open(output_file, "w") as f:
        json.dump(valid_data, f, indent=2)
    print(f"Synthesized {len(valid_data)} threads successfully to {output_file}.")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Generate synthetic dataset for LobsterTalk.")
    parser.add_argument("--num-threads", type=int, default=100, help="Number of threads to generate.")
    parser.add_argument("--output", type=str, default="synthetic_corpus.json", help="Output JSON file.")
    args = parser.parse_args()

    asyncio.run(synthesize_dataset(args.num_threads, args.output))
