"""Query Aliyun account balance. No secrets printed."""
from __future__ import annotations

from aliyun_rpc import load_env, rpc


def main() -> None:
    env = load_env()
    ak, sk = env["AccessKey_ID"], env["AccessKey_Secret"]
    for endpoint in ("https://business.aliyuncs.com", "https://business.ap-southeast-1.aliyuncs.com"):
        r = rpc(
            "QueryAccountBalance",
            {},
            version="2017-12-14",
            endpoint=endpoint,
            ak=ak, sk=sk,
        )
        data = r.get("Data") or {}
        print(
            endpoint.split("//")[1],
            r.get("Code") or "ok",
            "available", data.get("AvailableAmount") or data.get("AvailableCashAmount"),
            "currency", data.get("Currency"),
            str(r.get("Message", ""))[:160],
        )


if __name__ == "__main__":
    main()
