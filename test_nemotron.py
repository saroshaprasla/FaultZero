import os
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()
client = OpenAI(
    base_url="https://integrate.api.nvidia.com/v1",
    api_key=os.environ["NVIDIA_API_KEY"],
)

r = client.chat.completions.create(
    model="nvidia/nemotron-3.5-super-vl-120b-a12b",
    messages=[{"role": "user", "content": "In one sentence: what is a cascading failure in a data center?"}],
    max_tokens=400,
    temperature=0.2,
    extra_body={"chat_template_kwargs": {"enable_thinking": False}},

)
print(r.choices[0].message.content)