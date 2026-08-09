import asyncio, edge_tts

async def test():
    text = "大器晚成，不怕起步晚，只怕你不敢。"
    comm = edge_tts.Communicate(text, "zh-CN-XiaoxiaoNeural", rate="+5%")
    await comm.save("test_voice.wav")
    print("OK - test_voice.wav saved")

asyncio.run(test())
