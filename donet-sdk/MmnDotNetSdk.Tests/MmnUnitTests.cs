using System.Net;
using System.Numerics;
using System.Text;
using System.Text.Json;
using Google.Protobuf;
using Grpc.Core;
using Grpc.Net.Client;
using Mmn;
using MmnDotNetSdk.Models;
using MmnDotNetSdk.Utils;
using Xunit;

namespace MmnDotNetSdk.Tests
{
    internal sealed class FakeCallInvoker : CallInvoker
    {
        private readonly Func<string, object, CancellationToken, Task<object>> _handler;

        public FakeCallInvoker(Func<string, object, CancellationToken, Task<object>> handler)
        {
            _handler = handler;
        }

        public override TResponse BlockingUnaryCall<TRequest, TResponse>(
            Method<TRequest, TResponse> method,
            string? host,
            CallOptions options,
            TRequest request)
        {
            throw new NotSupportedException();
        }

        public override AsyncUnaryCall<TResponse> AsyncUnaryCall<TRequest, TResponse>(
            Method<TRequest, TResponse> method,
            string? host,
            CallOptions options,
            TRequest request)
        {
            var task = InvokeAsync<TResponse>(method.FullName, request!, options.CancellationToken);
            return new AsyncUnaryCall<TResponse>(
                task,
                Task.FromResult(new Metadata()),
                () => Status.DefaultSuccess,
                () => new Metadata(),
                () => { });
        }

        private async Task<TResponse> InvokeAsync<TResponse>(
            string methodFullName,
            object request,
            CancellationToken cancellationToken)
        {
            var result = await _handler(methodFullName, request, cancellationToken);
            return (TResponse)result;
        }

        public override AsyncServerStreamingCall<TResponse> AsyncServerStreamingCall<TRequest, TResponse>(
            Method<TRequest, TResponse> method,
            string? host,
            CallOptions options,
            TRequest request)
        {
            throw new NotSupportedException();
        }

        public override AsyncClientStreamingCall<TRequest, TResponse> AsyncClientStreamingCall<TRequest, TResponse>(
            Method<TRequest, TResponse> method,
            string? host,
            CallOptions options)
        {
            throw new NotSupportedException();
        }

        public override AsyncDuplexStreamingCall<TRequest, TResponse> AsyncDuplexStreamingCall<TRequest, TResponse>(
            Method<TRequest, TResponse> method,
            string? host,
            CallOptions options)
        {
            throw new NotSupportedException();
        }
    }

    internal sealed class FakeHttpMessageHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> _handler;

        public FakeHttpMessageHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> handler)
        {
            _handler = handler;
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            return _handler(request, cancellationToken);
        }
    }

    public class MmnUnitTests
    {
        [Fact]
        public void MmnNodeClient_Constructors_And_Dispose()
        {
            Assert.Throws<ArgumentNullException>(() => new MmnNodeClient((GrpcChannel)null!));
            Assert.Throws<ArgumentNullException>(() => new MmnNodeClient((CallInvoker)null!));

            var byEndpoint = new MmnNodeClient("http://localhost:50051");
            Assert.NotNull(byEndpoint.Channel);
            byEndpoint.Dispose();
            byEndpoint.Dispose();

            var channel = GrpcChannel.ForAddress("http://localhost:50052");
            var byChannel = new MmnNodeClient(channel);
            Assert.Same(channel, byChannel.Channel);
            byChannel.Dispose();

            var invoker = new FakeCallInvoker((_, _, _) => Task.FromResult<object>(new Empty()));
            var byInvoker = new MmnNodeClient(invoker);
            Assert.Null(byInvoker.Channel);
            byInvoker.Dispose();

            var facade = new MmnClient(new Config
            {
                Endpoint = "http://localhost:50053",
                ZkProveEndpoint = "http://localhost:8282"
            });
            Assert.NotNull(facade.NodeClient);
            Assert.NotNull(facade.ZkProveClient);
            facade.NodeClient.Dispose();
        }

        [Fact]
        public async Task MmnNodeClient_CheckHealthAsync_Success_And_Error()
        {
            var invoker = new FakeCallInvoker((method, req, _) =>
            {
                Assert.Equal("/mmn.HealthService/Check", method);
                Assert.IsType<Empty>(req);
                return Task.FromResult<object>(new Mmn.HealthCheckResponse
                {
                    Status = Mmn.HealthCheckResponse.Types.ServingStatus.Serving,
                    NodeId = "node-1",
                    CurrentSlot = 42
                });
            });
            var client = new MmnNodeClient(invoker);
            var health = await client.CheckHealthAsync();
            Assert.Equal(Mmn.HealthCheckResponse.Types.ServingStatus.Serving, health.Status);
            Assert.Equal("node-1", health.NodeId);
            Assert.Equal(42UL, health.CurrentSlot);

            var failingClient = new MmnNodeClient(new FakeCallInvoker((_, _, _) =>
                Task.FromException<object>(new RpcException(new Status(StatusCode.Unavailable, "down")))));
            var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => failingClient.CheckHealthAsync());
            Assert.Contains("Health check failed:", ex.Message);
        }

        [Fact]
        public async Task MmnNodeClient_AddTxAsync_Success_NotOk_And_Error()
        {
            var (pub, priv) = CryptoHelper.GenerateEd25519KeyPair();
            var sender = CryptoHelper.Base58Encode(pub);
            var recipient = CryptoHelper.GenerateAddress("recipient-addtx");
            var tx = CryptoHelper.BuildTransferTx(
                (int)TxType.Faucet,
                sender,
                recipient,
                new BigInteger(1000),
                1,
                1700000000,
                "memo",
                new Dictionary<string, string> { ["type"] = "transfer" },
                "",
                "");
            var signedTx = CryptoHelper.SignTx(tx, pub, priv);

            var okClient = new MmnNodeClient(new FakeCallInvoker((method, req, _) =>
            {
                Assert.Equal("/mmn.TxService/AddTx", method);
                var proto = Assert.IsType<SignedTxMsg>(req);
                Assert.Equal(sender, proto.TxMsg.Sender);
                Assert.Equal(signedTx.Sig, proto.Signature);
                return Task.FromResult<object>(new Mmn.AddTxResponse
                {
                    Ok = true,
                    TxHash = "0xhash1",
                    Error = ""
                });
            }));
            var res = await okClient.AddTxAsync(signedTx);
            Assert.True(res.Ok);
            Assert.Equal("0xhash1", res.TxHash);
            Assert.Equal("", res.Error);

            var rejectedClient = new MmnNodeClient(new FakeCallInvoker((_, _, _) =>
                Task.FromResult<object>(new Mmn.AddTxResponse
                {
                    Ok = false,
                    TxHash = "",
                    Error = "bad nonce"
                })));
            var rejectedEx = await Assert.ThrowsAsync<InvalidOperationException>(() => rejectedClient.AddTxAsync(signedTx));
            Assert.Contains("bad nonce", rejectedEx.Message);

            var rpcErrorClient = new MmnNodeClient(new FakeCallInvoker((_, _, _) =>
                Task.FromException<object>(new RpcException(new Status(StatusCode.Internal, "boom")))));
            var rpcEx = await Assert.ThrowsAsync<InvalidOperationException>(() => rpcErrorClient.AddTxAsync(signedTx));
            Assert.Contains("Add transaction failed:", rpcEx.Message);
        }

        [Fact]
        public async Task MmnNodeClient_GetAccountAsync_Success_And_Fallback()
        {
            var addr = CryptoHelper.GenerateAddress("acct-user");
            var okClient = new MmnNodeClient(new FakeCallInvoker((method, req, _) =>
            {
                Assert.Equal("/mmn.AccountService/GetAccount", method);
                Assert.Equal(addr, Assert.IsType<GetAccountRequest>(req).Address);
                return Task.FromResult<object>(new GetAccountResponse
                {
                    Address = addr,
                    Balance = "987654321000000000000",
                    Nonce = 12,
                    Decimals = 6
                });
            }));
            var account = await okClient.GetAccountAsync(addr);
            Assert.Equal(addr, account.Address);
            Assert.Equal(BigInteger.Parse("987654321000000000000"), account.Balance);
            Assert.Equal(12UL, account.Nonce);

            var failingClient = new MmnNodeClient(new FakeCallInvoker((_, _, _) =>
                Task.FromException<object>(new RpcException(new Status(StatusCode.NotFound, "missing")))));
            var fallback = await failingClient.GetAccountAsync(addr);
            Assert.Equal(addr, fallback.Address);
            Assert.Equal(BigInteger.Zero, fallback.Balance);
            Assert.Equal(0UL, fallback.Nonce);
        }

        [Fact]
        public async Task MmnNodeClient_GetTxHistoryAsync_Success_And_Error()
        {
            var addr = CryptoHelper.GenerateAddress("hist-user");
            var okClient = new MmnNodeClient(new FakeCallInvoker((method, req, _) =>
            {
                Assert.Equal("/mmn.AccountService/GetTxHistory", method);
                var historyReq = Assert.IsType<GetTxHistoryRequest>(req);
                Assert.Equal(addr, historyReq.Address);
                Assert.Equal(10U, historyReq.Limit);
                Assert.Equal(5U, historyReq.Offset);
                Assert.Equal(2U, historyReq.Filter);

                var resp = new GetTxHistoryResponse { Total = 1, Decimals = 6 };
                resp.Txs.Add(new TxMeta
                {
                    Sender = addr,
                    Recipient = "r1",
                    Amount = "500",
                    Nonce = 3,
                    Timestamp = 1700000000,
                    Status = TxMeta.Types.Status.Finalized
                });
                return Task.FromResult<object>(resp);
            }));

            var history = await okClient.GetTxHistoryAsync(addr, 10, 5, 2);
            Assert.Equal(1U, history.Total);
            Assert.Single(history.Txs);
            Assert.Equal(TxMetaStatus.Finalized, history.Txs[0].Status);
            Assert.Equal(new BigInteger(500), history.Txs[0].Amount);

            var failingClient = new MmnNodeClient(new FakeCallInvoker((_, _, _) =>
                Task.FromException<object>(new RpcException(new Status(StatusCode.Internal, "db err")))));
            var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => failingClient.GetTxHistoryAsync(addr, 10, 0, 0));
            Assert.Contains("Get transaction history failed:", ex.Message);
        }

        [Fact]
        public async Task MmnNodeClient_SubscribeTransactionStatusAsync_ReturnsClient()
        {
            var client = new MmnNodeClient(new FakeCallInvoker((_, _, _) => Task.FromResult<object>(new Empty())));
            var txClient = await client.SubscribeTransactionStatusAsync();
            Assert.NotNull(txClient);
        }

        [Fact]
        public async Task MmnNodeClient_GetTxByHashAsync_Success_ErrorField_And_RpcException()
        {
            var okClient = new MmnNodeClient(new FakeCallInvoker((method, req, _) =>
            {
                Assert.Equal("/mmn.TxService/GetTxByHash", method);
                Assert.Equal("0xabc", Assert.IsType<GetTxByHashRequest>(req).TxHash);
                return Task.FromResult<object>(new GetTxByHashResponse
                {
                    Error = "",
                    Decimals = 6,
                    Tx = new Mmn.TxInfo
                    {
                        Sender = "s1",
                        Recipient = "r1",
                        Amount = "123456789",
                        Timestamp = 1700000500,
                        TextData = "hello",
                        Nonce = 9,
                        Slot = 777,
                        Blockhash = "0xblock777",
                        Status = TransactionStatus.Finalized,
                        ErrMsg = "",
                        ExtraInfo = "{\"type\":\"transfer\"}",
                        TxHash = "0xabc"
                    }
                });
            }));

            var info = await okClient.GetTxByHashAsync("0xabc");
            Assert.Equal("s1", info.Sender);
            Assert.Equal("r1", info.Recipient);
            Assert.Equal(new BigInteger(123456789), info.Amount);
            Assert.Equal(1700000500L, info.Timestamp);
            Assert.Equal("hello", info.TextData);
            Assert.Equal(9UL, info.Nonce);
            Assert.Equal(777UL, info.Slot);
            Assert.Equal("0xblock777", info.Blockhash);
            Assert.Equal("Finalized", info.Status);
            Assert.Equal("", info.ErrMsg);
            Assert.Equal("{\"type\":\"transfer\"}", info.ExtraInfo);
            Assert.Equal("0xabc", info.TxHash);
            Assert.Equal("transfer", info.DeserializedExtraInfo()!["type"]);

            var errorFieldClient = new MmnNodeClient(new FakeCallInvoker((_, _, _) =>
                Task.FromResult<object>(new GetTxByHashResponse { Error = "tx not found" })));
            var errEx = await Assert.ThrowsAsync<InvalidOperationException>(() => errorFieldClient.GetTxByHashAsync("0xmissing"));
            Assert.Contains("tx not found", errEx.Message);

            var rpcErrorClient = new MmnNodeClient(new FakeCallInvoker((_, _, _) =>
                Task.FromException<object>(new RpcException(new Status(StatusCode.Unavailable, "offline")))));
            var rpcEx = await Assert.ThrowsAsync<InvalidOperationException>(() => rpcErrorClient.GetTxByHashAsync("0xmissing"));
            Assert.Contains("Get transaction by hash failed:", rpcEx.Message);
        }

        [Fact]
        public async Task MmnNodeClient_GetCurrentNonceAsync_Success_ErrorField_And_RpcException()
        {
            var okClient = new MmnNodeClient(new FakeCallInvoker((method, req, _) =>
            {
                Assert.Equal("/mmn.AccountService/GetCurrentNonce", method);
                var nonceReq = Assert.IsType<GetCurrentNonceRequest>(req);
                Assert.Equal("addr-1", nonceReq.Address);
                Assert.Equal("pending", nonceReq.Tag);
                return Task.FromResult<object>(new GetCurrentNonceResponse
                {
                    Address = "addr-1",
                    Nonce = 55,
                    Tag = "pending",
                    Error = ""
                });
            }));
            var nonce = await okClient.GetCurrentNonceAsync("addr-1", "pending");
            Assert.Equal(55UL, nonce);

            var errorFieldClient = new MmnNodeClient(new FakeCallInvoker((_, _, _) =>
                Task.FromResult<object>(new GetCurrentNonceResponse
                {
                    Address = "addr-1",
                    Nonce = 0,
                    Tag = "latest",
                    Error = "invalid tag"
                })));
            var errEx = await Assert.ThrowsAsync<InvalidOperationException>(() => errorFieldClient.GetCurrentNonceAsync("addr-1", "bad"));
            Assert.Contains("invalid tag", errEx.Message);

            var rpcErrorClient = new MmnNodeClient(new FakeCallInvoker((_, _, _) =>
                Task.FromException<object>(new RpcException(new Status(StatusCode.DeadlineExceeded, "timeout")))));
            var rpcEx = await Assert.ThrowsAsync<InvalidOperationException>(() => rpcErrorClient.GetCurrentNonceAsync("addr-1", "latest"));
            Assert.Contains("Get current nonce failed:", rpcEx.Message);
        }

        [Fact]
        public async Task ZkProveClient_Constructors_GenerateZkProof_And_HealthCheckAsync()
        {
            Assert.Throws<ArgumentNullException>(() => new ZkProveClient("http://zk.local", null!));
            var defaultClient = new ZkProveClient("http://zk.local");
            Assert.NotNull(defaultClient);

            HttpRequestMessage? capturedProve = null;
            string? capturedProveBody = null;
            var proveHandler = new FakeHttpMessageHandler(async (req, _) =>
            {
                capturedProve = req;
                capturedProveBody = await req.Content!.ReadAsStringAsync();
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        "{\"data\":{\"proof\":\"zk-proof-1\",\"public_input\":\"zk-pub-1\"},\"error\":null}",
                        Encoding.UTF8,
                        "application/json")
                };
            });
            var zkClient = new ZkProveClient("http://zk.local", new HttpClient(proveHandler));
            var proveResp = await zkClient.GenerateZkProof("u1", "addr1", "epk1", "jwt1");

            Assert.NotNull(capturedProve);
            Assert.Equal(HttpMethod.Post, capturedProve!.Method);
            Assert.Equal("http://zk.local/prove", capturedProve.RequestUri!.ToString());
            var payload = JsonSerializer.Deserialize<Dictionary<string, string>>(capturedProveBody!);
            Assert.Equal("u1", payload!["user_id"]);
            Assert.Equal("addr1", payload["address"]);
            Assert.Equal("epk1", payload["ephemeral_pk"]);
            Assert.Equal("jwt1", payload["jwt"]);
            Assert.Equal("zk-proof-1", proveResp!.Data!.Proof);
            Assert.Equal("zk-pub-1", proveResp.Data.PublicInput);
            Assert.Null(proveResp.Error);

            var failProveClient = new ZkProveClient(
                "http://zk.local",
                new HttpClient(new FakeHttpMessageHandler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.BadRequest)
                {
                    ReasonPhrase = "Bad Request",
                    Content = new StringContent("bad jwt")
                }))));
            var proveEx = await Assert.ThrowsAsync<HttpRequestException>(() =>
                failProveClient.GenerateZkProof("u1", "addr1", "epk1", "bad"));
            Assert.Contains("400", proveEx.Message);
            Assert.Contains("bad jwt", proveEx.Message);

            var healthClient = new ZkProveClient(
                "http://zk.local",
                new HttpClient(new FakeHttpMessageHandler((req, _) =>
                {
                    Assert.Equal(HttpMethod.Get, req.Method);
                    Assert.Equal("http://zk.local/health/check", req.RequestUri!.ToString());
                    return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent(
                            "{\"status\":\"healthy\",\"timestamp\":1700000000,\"message\":\"ok\",\"version\":\"1.2.3\"}",
                            Encoding.UTF8,
                            "application/json")
                    });
                })));
            var health = await healthClient.HealthCheckAsync();
            Assert.Equal("healthy", health.Status);
            Assert.Equal(1700000000L, health.Timestamp);
            Assert.Equal("ok", health.Message);
            Assert.Equal("1.2.3", health.Version);

            var nullHealthClient = new ZkProveClient(
                "http://zk.local",
                new HttpClient(new FakeHttpMessageHandler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("null", Encoding.UTF8, "application/json")
                }))));
            var emptyHealth = await nullHealthClient.HealthCheckAsync();
            Assert.Equal(string.Empty, emptyHealth.Status);

            var failHealthClient = new ZkProveClient(
                "http://zk.local",
                new HttpClient(new FakeHttpMessageHandler((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.InternalServerError)
                {
                    ReasonPhrase = "Internal Server Error",
                    Content = new StringContent("unhealthy")
                }))));
            var healthEx = await Assert.ThrowsAsync<HttpRequestException>(() => failHealthClient.HealthCheckAsync());
            Assert.Contains("500", healthEx.Message);
            Assert.Contains("unhealthy", healthEx.Message);
        }

        [Fact]
        public void CryptoHelper_Sign_Verify_Serialize_And_BuildTransferTx()
        {
            var (pub, seed) = CryptoHelper.GenerateEd25519KeyPair();
            var sender = CryptoHelper.Base58Encode(pub);
            var recipient = CryptoHelper.GenerateAddress("bob");

            var transferTx = CryptoHelper.BuildTransferTx(
                (int)TxType.Transfer,
                sender,
                recipient,
                new BigInteger(500),
                1,
                1700000000,
                "memo",
                new Dictionary<string, string> { ["type"] = "transfer" },
                "proof",
                "pub");
            var signedTransfer = CryptoHelper.SignTx(transferTx, pub, seed);
            Assert.True(CryptoHelper.Verify(transferTx, signedTransfer.Sig));

            var tamperedTx = CryptoHelper.BuildTransferTx(
                (int)TxType.Transfer,
                sender,
                recipient,
                new BigInteger(501),
                1,
                1700000000,
                "memo",
                new Dictionary<string, string> { ["type"] = "transfer" },
                "proof",
                "pub");
            Assert.False(CryptoHelper.Verify(tamperedTx, signedTransfer.Sig));
            Assert.False(CryptoHelper.Verify(transferTx, "0OIl-invalid"));
            Assert.False(CryptoHelper.Verify(transferTx, CryptoHelper.Base58Encode(Encoding.UTF8.GetBytes("null"))));

            var faucetTx = CryptoHelper.BuildTransferTx(
                (int)TxType.Faucet,
                sender,
                recipient,
                new BigInteger(500),
                2,
                1700000000,
                "faucet",
                null,
                "",
                "");
            var signedFaucet = CryptoHelper.SignTx(faucetTx, pub, seed);
            Assert.True(CryptoHelper.Verify(faucetTx, signedFaucet.Sig));
            Assert.False(CryptoHelper.Verify(faucetTx, "0OIl-invalid"));

            Assert.Throws<ArgumentException>(() => CryptoHelper.SignTx(faucetTx, pub, new byte[16]));

            var rawNullTx = new Tx
            {
                Type = 0,
                Sender = sender,
                Recipient = recipient,
                Amount = new BigInteger(1),
                Nonce = 0,
                TextData = null!,
                ExtraInfo = null!
            };
            var serialized = Encoding.UTF8.GetString(CryptoHelper.Serialize(rawNullTx));
            Assert.Equal($"0|{sender}|{recipient}|1||0|", serialized);
        }

        [Fact]
        public void ValidationHelper_And_ProtoConverter_And_ModelsTxInfo()
        {
            var validAddr = CryptoHelper.GenerateAddress("valid-user");
            ValidationHelper.ValidateAddress(validAddr);
            Assert.Throws<ValidationException>(() => ValidationHelper.ValidateAddress(""));
            Assert.Throws<ValidationException>(() => ValidationHelper.ValidateAddress("0OIl-invalid"));
            Assert.Throws<ValidationException>(() => ValidationHelper.ValidateAddress(CryptoHelper.Base58Encode(new byte[] { 1, 2, 3, 4, 5 })));

            ValidationHelper.ValidateAmount(new BigInteger(1));
            Assert.Throws<ValidationException>(() => ValidationHelper.ValidateAmount(BigInteger.Zero));
            Assert.Throws<ValidationException>(() => ValidationHelper.ValidateAmount(new BigInteger(-5)));

            Assert.Equal(string.Empty, ValidationHelper.SerializeTxExtraInfo(null));
            var json = ValidationHelper.SerializeTxExtraInfo(new Dictionary<string, string> { ["k"] = "v" });
            Assert.Equal("{\"k\":\"v\"}", json);

            Assert.Null(ValidationHelper.DeserializeTxExtraInfo(""));
            var parsed = ValidationHelper.DeserializeTxExtraInfo(json);
            Assert.Equal("v", parsed!["k"]);
            Assert.Throws<ValidationException>(() => ValidationHelper.DeserializeTxExtraInfo("{not-json"));

            Assert.Equal(new BigInteger(25_000_000), ValidationHelper.AmountToDecimal(new BigInteger(25)));

            Assert.Equal(BigInteger.Zero, ProtoConverter.Uint256FromString(""));
            Assert.Equal(BigInteger.Parse("123456789012345678901234567890"), ProtoConverter.Uint256FromString("123456789012345678901234567890"));
            Assert.Equal("42", ProtoConverter.Uint256ToString(new BigInteger(42)));

            var tx = new Tx
            {
                Type = 1,
                Sender = validAddr,
                Recipient = validAddr,
                Amount = new BigInteger(100),
                Nonce = 7,
                Timestamp = 1700000001,
                TextData = "txt",
                ExtraInfo = json,
                ZkProof = "p",
                ZkPub = "u"
            };
            var signedMsg = ProtoConverter.ToProtoSigTx(new SignedTx { Tx = tx, Sig = "sig-1" });
            Assert.Equal("sig-1", signedMsg.Signature);
            Assert.Equal("100", signedMsg.TxMsg.Amount);
            Assert.Equal("txt", signedMsg.TxMsg.TextData);

            var acc = ProtoConverter.FromProtoAccount(new GetAccountResponse
            {
                Address = validAddr,
                Balance = "999",
                Nonce = 4
            });
            Assert.Equal(validAddr, acc.Address);
            Assert.Equal(new BigInteger(999), acc.Balance);
            Assert.Equal(4UL, acc.Nonce);

            var txInfo = new Models.TxInfo
            {
                Slot = 100,
                Blockhash = "0xbh",
                TxHash = "0xth",
                ExtraInfo = ""
            };
            Assert.Equal(100UL, txInfo.Slot);
            Assert.Equal("0xbh", txInfo.Blockhash);
            Assert.Equal("0xth", txInfo.TxHash);
            Assert.Null(txInfo.DeserializedExtraInfo());

            txInfo.ExtraInfo = "{\"a\":\"b\"}";
            Assert.Equal("b", txInfo.DeserializedExtraInfo()!["a"]);

            txInfo.ExtraInfo = "{broken";
            Assert.Null(txInfo.DeserializedExtraInfo());
        }

        [Fact]
        public void Protobuf_NewFields_Roundtrip()
        {
            var txData = new TransactionData
            {
                TxHash = "0xtx1",
                Sender = "sender-1",
                Recipient = "recipient-1",
                Amount = "100",
                Nonce = 1,
                Timestamp = 1700000000,
                Status = TransactionStatus.Confirmed,
                TextData = "t",
                ExtraInfo = "{}",
                TransactionType = 2
            };
            var decodedTxData = TransactionData.Parser.ParseFrom(txData.ToByteArray());
            Assert.Equal(2, decodedTxData.TransactionType);
            Assert.Equal(TransactionStatus.Confirmed, decodedTxData.Status);

            var protoTxInfo = new Mmn.TxInfo
            {
                Sender = "s",
                Recipient = "r",
                Amount = "50",
                Timestamp = 1700000001,
                TextData = "hi",
                Nonce = 2,
                Slot = 99,
                Blockhash = "0xblk99",
                Status = TransactionStatus.Failed,
                ErrMsg = "err",
                ExtraInfo = "{}",
                TxHash = "0xtxhash99"
            };
            var decodedTxInfo = Mmn.TxInfo.Parser.ParseFrom(protoTxInfo.ToByteArray());
            Assert.Equal(TransactionStatus.Failed, decodedTxInfo.Status);
            Assert.Equal("0xtxhash99", decodedTxInfo.TxHash);
            Assert.Equal(99UL, decodedTxInfo.Slot);
            Assert.Equal("0xblk99", decodedTxInfo.Blockhash);

            var statusInfo = new TransactionStatusInfo
            {
                TxHash = "0xtx2",
                Status = TransactionStatus.Finalized,
                BlockSlot = 123,
                BlockHash = "0xblk123",
                Confirmations = 5,
                ErrorMessage = "",
                Timestamp = 1700000002,
                ExtraInfo = "{}",
                Amount = "200",
                TextData = "ok",
                Sender = "sender-pr24",
                Recipient = "recipient-pr24"
            };
            var decodedStatus = TransactionStatusInfo.Parser.ParseFrom(statusInfo.ToByteArray());
            Assert.Equal("sender-pr24", decodedStatus.Sender);
            Assert.Equal("recipient-pr24", decodedStatus.Recipient);
            Assert.Equal(TransactionStatus.Finalized, decodedStatus.Status);
        }
    }
}
