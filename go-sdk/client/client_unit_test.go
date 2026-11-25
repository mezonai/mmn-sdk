package client

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"testing"

	"github.com/holiman/uint256"
	mmnpb "github.com/mezonai/mmn-sdk/go-sdk/proto"
	"github.com/mr-tron/base58"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

var _ MainnetClient = (*MmnClient)(nil)

type mockHealthServer struct {
	mmnpb.UnimplementedHealthServiceServer
	checkFn func(context.Context, *mmnpb.Empty) (*mmnpb.HealthCheckResponse, error)
}

func (m *mockHealthServer) Check(ctx context.Context, req *mmnpb.Empty) (*mmnpb.HealthCheckResponse, error) {
	return m.checkFn(ctx, req)
}

type mockTxServer struct {
	mmnpb.UnimplementedTxServiceServer
	addTxFn       func(context.Context, *mmnpb.SignedTxMsg) (*mmnpb.AddTxResponse, error)
	getTxByHashFn func(context.Context, *mmnpb.GetTxByHashRequest) (*mmnpb.GetTxByHashResponse, error)
	subscribeFn   func(*mmnpb.SubscribeTransactionStatusRequest, mmnpb.TxService_SubscribeTransactionStatusServer) error
}

func (m *mockTxServer) AddTx(ctx context.Context, req *mmnpb.SignedTxMsg) (*mmnpb.AddTxResponse, error) {
	return m.addTxFn(ctx, req)
}

func (m *mockTxServer) GetTxByHash(ctx context.Context, req *mmnpb.GetTxByHashRequest) (*mmnpb.GetTxByHashResponse, error) {
	return m.getTxByHashFn(ctx, req)
}

func (m *mockTxServer) SubscribeTransactionStatus(req *mmnpb.SubscribeTransactionStatusRequest, stream mmnpb.TxService_SubscribeTransactionStatusServer) error {
	return m.subscribeFn(req, stream)
}

type mockAccountServer struct {
	mmnpb.UnimplementedAccountServiceServer
	getAccountFn      func(context.Context, *mmnpb.GetAccountRequest) (*mmnpb.GetAccountResponse, error)
	getCurrentNonceFn func(context.Context, *mmnpb.GetCurrentNonceRequest) (*mmnpb.GetCurrentNonceResponse, error)
}

func (m *mockAccountServer) GetAccount(ctx context.Context, req *mmnpb.GetAccountRequest) (*mmnpb.GetAccountResponse, error) {
	return m.getAccountFn(ctx, req)
}

func (m *mockAccountServer) GetCurrentNonce(ctx context.Context, req *mmnpb.GetCurrentNonceRequest) (*mmnpb.GetCurrentNonceResponse, error) {
	return m.getCurrentNonceFn(ctx, req)
}

func startTestGRPCServer(t *testing.T, health *mockHealthServer, tx *mockTxServer, acc *mockAccountServer) *MmnClient {
	t.Helper()

	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to listen: %v", err)
	}

	srv := grpc.NewServer()
	if health != nil {
		mmnpb.RegisterHealthServiceServer(srv, health)
	}
	if tx != nil {
		mmnpb.RegisterTxServiceServer(srv, tx)
	}
	if acc != nil {
		mmnpb.RegisterAccountServiceServer(srv, acc)
	}

	go func() {
		_ = srv.Serve(lis)
	}()

	cli, err := NewClient(Config{Endpoint: lis.Addr().String(), UseTLS: false})
	if err != nil {
		srv.Stop()
		_ = lis.Close()
		t.Fatalf("NewClient failed: %v", err)
	}

	t.Cleanup(func() {
		_ = cli.Close()
		srv.Stop()
		_ = lis.Close()
	})

	return cli
}

func TestUnit_NewClient_TLS_Conn_Close(t *testing.T) {
	tlsClient, err := NewClient(Config{Endpoint: "localhost:9001", UseTLS: true})
	if err != nil {
		t.Fatalf("NewClient(UseTLS=true) unexpected error: %v", err)
	}
	if tlsClient.Conn() == nil {
		t.Fatal("expected non-nil Conn()")
	}
	if err := tlsClient.Close(); err != nil {
		t.Fatalf("Close() unexpected error: %v", err)
	}

	emptyClient := &MmnClient{}
	if err := emptyClient.Close(); err != nil {
		t.Fatalf("Close() on nil conn unexpected error: %v", err)
	}

	if _, err := NewClient(Config{Endpoint: "bad://%zz", UseTLS: false}); err == nil {
		t.Fatal("expected error for malformed target URI")
	}
}

func TestUnit_CheckHealth(t *testing.T) {
	var fail bool
	cli := startTestGRPCServer(t, &mockHealthServer{
		checkFn: func(_ context.Context, _ *mmnpb.Empty) (*mmnpb.HealthCheckResponse, error) {
			if fail {
				return nil, status.Error(codes.Unavailable, "node down")
			}
			return &mmnpb.HealthCheckResponse{
				Status:      mmnpb.HealthCheckResponse_SERVING,
				NodeId:      "node-42",
				CurrentSlot: 128,
				BlockHeight: 64,
			}, nil
		},
	}, nil, nil)

	resp, err := cli.CheckHealth(context.Background())
	if err != nil {
		t.Fatalf("CheckHealth failed: %v", err)
	}
	if resp.Status != mmnpb.HealthCheckResponse_SERVING || resp.NodeId != "node-42" || resp.CurrentSlot != 128 {
		t.Fatalf("unexpected health response: %+v", resp)
	}

	fail = true
	if _, err := cli.CheckHealth(context.Background()); err == nil {
		t.Fatal("expected error from CheckHealth")
	}
}

func TestUnit_AddTx(t *testing.T) {
	var mode string
	cli := startTestGRPCServer(t, nil, &mockTxServer{
		addTxFn: func(_ context.Context, req *mmnpb.SignedTxMsg) (*mmnpb.AddTxResponse, error) {
			switch mode {
			case "rpc_err":
				return nil, status.Error(codes.Internal, "rpc failure")
			case "not_ok":
				return &mmnpb.AddTxResponse{Ok: false, Error: "invalid nonce"}, nil
			default:
				return &mmnpb.AddTxResponse{Ok: true, TxHash: "0xtx_" + req.TxMsg.Sender}, nil
			}
		},
	}, nil)

	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey failed: %v", err)
	}
	sender := base58.Encode(pub)
	recipient := GenerateAddress("recipient-addtx")

	tx, err := BuildTransferTx(TxTypeTransferByKey, sender, recipient, uint256.NewInt(100), 1, 1700000000, "hello", map[string]string{"type": "transfer"}, "", "")
	if err != nil {
		t.Fatalf("BuildTransferTx failed: %v", err)
	}
	signed, err := SignTx(tx, pub, priv.Seed())
	if err != nil {
		t.Fatalf("SignTx failed: %v", err)
	}

	res, err := cli.AddTx(context.Background(), signed)
	if err != nil {
		t.Fatalf("AddTx failed: %v", err)
	}
	if !res.Ok || res.TxHash != "0xtx_"+sender {
		t.Fatalf("unexpected AddTx response: %+v", res)
	}

	mode = "not_ok"
	if _, err := cli.AddTx(context.Background(), signed); err == nil || !strings.Contains(err.Error(), "invalid nonce") {
		t.Fatalf("expected not_ok error, got: %v", err)
	}

	mode = "rpc_err"
	if _, err := cli.AddTx(context.Background(), signed); err == nil {
		t.Fatal("expected rpc error from AddTx")
	}
}

func TestUnit_GetAccount_And_GetCurrentNonce(t *testing.T) {
	var fail bool
	addr := GenerateAddress("acct-user")
	cli := startTestGRPCServer(t, nil, nil, &mockAccountServer{
		getAccountFn: func(_ context.Context, req *mmnpb.GetAccountRequest) (*mmnpb.GetAccountResponse, error) {
			if fail {
				return nil, status.Error(codes.NotFound, "account missing")
			}
			return &mmnpb.GetAccountResponse{
				Address: req.Address,
				Balance: "123456789000",
				Nonce:   9,
			}, nil
		},
		getCurrentNonceFn: func(_ context.Context, req *mmnpb.GetCurrentNonceRequest) (*mmnpb.GetCurrentNonceResponse, error) {
			if fail {
				return nil, status.Error(codes.Internal, "nonce error")
			}
			if req.Tag != "pending" {
				return nil, status.Error(codes.InvalidArgument, "unexpected tag")
			}
			return &mmnpb.GetCurrentNonceResponse{
				Address: req.Address,
				Nonce:   10,
				Tag:     req.Tag,
			}, nil
		},
	})

	acc, err := cli.GetAccount(context.Background(), addr)
	if err != nil {
		t.Fatalf("GetAccount failed: %v", err)
	}
	if acc.Address != addr || acc.Balance.String() != "123456789000" || acc.Nonce != 9 {
		t.Fatalf("unexpected Account: %+v", acc)
	}

	nonce, err := cli.GetCurrentNonce(context.Background(), addr, "pending")
	if err != nil {
		t.Fatalf("GetCurrentNonce failed: %v", err)
	}
	if nonce != 10 {
		t.Fatalf("expected nonce 10, got %d", nonce)
	}

	fail = true
	zeroAcc, err := cli.GetAccount(context.Background(), addr)
	if err == nil {
		t.Fatal("expected error from GetAccount")
	}
	if zeroAcc.Address != addr || !zeroAcc.Balance.IsZero() || zeroAcc.Nonce != 0 {
		t.Fatalf("unexpected fallback Account on error: %+v", zeroAcc)
	}

	if _, err := cli.GetCurrentNonce(context.Background(), addr, "pending"); err == nil {
		t.Fatal("expected error from GetCurrentNonce")
	}
}

func TestUnit_GetTxByHash(t *testing.T) {
	var mode string
	cli := startTestGRPCServer(t, nil, &mockTxServer{
		getTxByHashFn: func(_ context.Context, req *mmnpb.GetTxByHashRequest) (*mmnpb.GetTxByHashResponse, error) {
			switch mode {
			case "rpc_err":
				return nil, status.Error(codes.Unavailable, "unavailable")
			case "resp_err":
				return &mmnpb.GetTxByHashResponse{Error: "tx not found"}, nil
			default:
				return &mmnpb.GetTxByHashResponse{
					Tx: &mmnpb.TxInfo{
						Sender:    "s1",
						Recipient: "r1",
						Amount:    "5000",
						Timestamp: 1700000001,
						TextData:  "note",
						Nonce:     4,
						Slot:      88,
						Blockhash: "0xblk88",
						Status:    mmnpb.TransactionStatus_FINALIZED,
						ErrMsg:    "",
						ExtraInfo: `{"type":"token-transfer"}`,
						TxHash:    req.TxHash,
					},
				}, nil
			}
		},
	}, nil)

	info, err := cli.GetTxByHash(context.Background(), "0xhash88")
	if err != nil {
		t.Fatalf("GetTxByHash failed: %v", err)
	}
	if info.Sender != "s1" || info.Recipient != "r1" || info.Amount.String() != "5000" ||
		info.Timestamp != 1700000001 || info.TextData != "note" || info.Nonce != 4 ||
		info.Slot != 88 || info.Blockhash != "0xblk88" ||
		info.Status != int32(mmnpb.TransactionStatus_FINALIZED) || info.TxHash != "0xhash88" {
		t.Fatalf("unexpected TxInfo: %+v", info)
	}

	extra, err := info.DeserializedExtraInfo()
	if err != nil || extra["type"] != "token-transfer" {
		t.Fatalf("unexpected DeserializedExtraInfo: %+v, err=%v", extra, err)
	}

	mode = "resp_err"
	if _, err := cli.GetTxByHash(context.Background(), "0xmissing"); err == nil || !strings.Contains(err.Error(), "tx not found") {
		t.Fatalf("expected resp error, got: %v", err)
	}

	mode = "rpc_err"
	if _, err := cli.GetTxByHash(context.Background(), "0xmissing"); err == nil {
		t.Fatal("expected rpc error from GetTxByHash")
	}
}

func TestUnit_SubscribeTransactionStatus(t *testing.T) {
	cli := startTestGRPCServer(t, nil, &mockTxServer{
		subscribeFn: func(_ *mmnpb.SubscribeTransactionStatusRequest, stream mmnpb.TxService_SubscribeTransactionStatusServer) error {
			events := []*mmnpb.TransactionStatusInfo{
				{
					TxHash:    "0xev1",
					Status:    mmnpb.TransactionStatus_CONFIRMED,
					BlockSlot: 101,
					BlockHash: "0xb101",
					Amount:    "1000",
					TextData:  "first",
					Sender:    "sender-ev1",
					Recipient: "recipient-ev1",
				},
				{
					TxHash:    "0xev2",
					Status:    mmnpb.TransactionStatus_FINALIZED,
					BlockSlot: 102,
					BlockHash: "0xb102",
					Amount:    "2000",
					TextData:  "second",
					Sender:    "sender-ev2",
					Recipient: "recipient-ev2",
				},
			}
			for _, ev := range events {
				if err := stream.Send(ev); err != nil {
					return err
				}
			}
			return nil
		},
	}, nil)

	stream, err := cli.SubscribeTransactionStatus(context.Background())
	if err != nil {
		t.Fatalf("SubscribeTransactionStatus failed: %v", err)
	}

	var received []*mmnpb.TransactionStatusInfo
	for {
		ev, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("stream.Recv failed: %v", err)
		}
		received = append(received, ev)
	}
	if len(received) != 2 {
		t.Fatalf("expected 2 events, got %d", len(received))
	}
	if received[0].Sender != "sender-ev1" || received[0].Recipient != "recipient-ev1" {
		t.Fatalf("unexpected first event sender/recipient: %+v", received[0])
	}
	if received[1].Sender != "sender-ev2" || received[1].Recipient != "recipient-ev2" {
		t.Fatalf("unexpected second event sender/recipient: %+v", received[1])
	}

	closedCli, err := NewClient(Config{Endpoint: "127.0.0.1:1", UseTLS: false})
	if err != nil {
		t.Fatalf("NewClient failed: %v", err)
	}
	_ = closedCli.Close()
	if _, err := closedCli.SubscribeTransactionStatus(context.Background()); err == nil {
		t.Fatal("expected error when subscribing on closed connection")
	}
}

func TestUnit_Crypto_And_Types(t *testing.T) {
	if got := GenerateAddress("3767478432163172990"); got != "DqrAfFo3yDQJhKuUo948RG4XfygHJPEe4UhcXxHF8hS2" {
		t.Fatalf("unexpected GenerateAddress: %s", got)
	}

	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey failed: %v", err)
	}
	sender := base58.Encode(pub)
	recipient := GenerateAddress("bob")

	if err := ValidateAddress(sender); err != nil {
		t.Fatalf("ValidateAddress valid failed: %v", err)
	}
	if !errors.Is(ValidateAddress("0OIl!@#"), ErrInvalidAddress) {
		t.Fatal("expected ErrInvalidAddress for non-base58")
	}
	if !errors.Is(ValidateAddress(base58.Encode([]byte{1, 2, 3})), ErrInvalidAddress) {
		t.Fatal("expected ErrInvalidAddress for wrong length")
	}

	if _, err := BuildTransferTx(TxTypeTransferByZk, "bad", recipient, uint256.NewInt(1), 1, 1, "", nil, "", ""); err == nil {
		t.Fatal("expected error for invalid sender")
	}
	if _, err := BuildTransferTx(TxTypeTransferByZk, sender, "bad", uint256.NewInt(1), 1, 1, "", nil, "", ""); err == nil {
		t.Fatal("expected error for invalid recipient")
	}
	if _, err := BuildTransferTx(TxTypeTransferByZk, sender, recipient, nil, 1, 1, "", nil, "", ""); !errors.Is(err, ErrInvalidAmount) {
		t.Fatalf("expected ErrInvalidAmount for nil amount, got %v", err)
	}
	if _, err := BuildTransferTx(TxTypeTransferByZk, sender, recipient, uint256.NewInt(0), 1, 1, "", nil, "", ""); !errors.Is(err, ErrInvalidAmount) {
		t.Fatalf("expected ErrInvalidAmount for zero amount, got %v", err)
	}

	contentTx, err := BuildTransferTx(TxTypeUserContent, sender, recipient, uint256.NewInt(0), 2, 1700000000, "post", nil, "p", "u")
	if err != nil {
		t.Fatalf("BuildTransferTx USER_CONTENT with zero amount failed: %v", err)
	}
	if contentTx.ExtraInfo != "" {
		t.Fatalf("expected empty ExtraInfo, got %q", contentTx.ExtraInfo)
	}

	keyTx, err := BuildTransferTx(TxTypeTransferByKey, sender, recipient, uint256.NewInt(500), 3, 1700000001, "memo", map[string]string{"type": "give-coffee"}, "", "")
	if err != nil {
		t.Fatalf("BuildTransferTx failed: %v", err)
	}
	if got := string(Serialize(keyTx)); got != `1|`+sender+`|`+recipient+`|500|memo|3|{"type":"give-coffee"}` {
		t.Fatalf("unexpected Serialize output: %s", got)
	}

	if _, err := SignTx(keyTx, pub, []byte{1, 2, 3}); !errors.Is(err, ErrUnsupportedKey) {
		t.Fatalf("expected ErrUnsupportedKey, got %v", err)
	}

	signedKey, err := SignTx(keyTx, pub, priv.Seed())
	if err != nil {
		t.Fatalf("SignTx key failed: %v", err)
	}
	if !Verify(keyTx, signedKey.Sig) {
		t.Fatal("Verify failed for valid key tx")
	}
	if Verify(keyTx, "0OIl") {
		t.Fatal("Verify should fail for invalid base58 sig")
	}
	if Verify(keyTx, base58.Encode([]byte{1, 2, 3})) {
		t.Fatal("Verify should fail for short sig")
	}
	badSenderTx := *keyTx
	badSenderTx.Sender = "0OIl"
	if Verify(&badSenderTx, signedKey.Sig) {
		t.Fatal("Verify should fail for invalid base58 sender")
	}
	badSenderTx.Sender = base58.Encode([]byte{1, 2, 3})
	if Verify(&badSenderTx, signedKey.Sig) {
		t.Fatal("Verify should fail for short sender")
	}

	zkTx, err := BuildTransferTx(TxTypeTransferByZk, sender, recipient, uint256.NewInt(777), 4, 1700000002, "zk", map[string]string{"type": "token-transfer"}, "zkp", "zku")
	if err != nil {
		t.Fatalf("BuildTransferTx zk failed: %v", err)
	}
	signedZk, err := SignTx(zkTx, pub, priv.Seed())
	if err != nil {
		t.Fatalf("SignTx zk failed: %v", err)
	}
	if !Verify(zkTx, signedZk.Sig) {
		t.Fatal("Verify failed for valid zk tx")
	}
	if Verify(zkTx, "0OIl") {
		t.Fatal("Verify should fail for non-base58 zk sig")
	}
	if Verify(zkTx, base58.Encode([]byte("not-json"))) {
		t.Fatal("Verify should fail for invalid json userSig")
	}
	shortUserSigBytes, _ := json.Marshal(UserSig{PubKey: []byte{1}, Sig: []byte{2}})
	if Verify(zkTx, base58.Encode(shortUserSigBytes)) {
		t.Fatal("Verify should fail for short userSig fields")
	}
}

func TestUnit_ValidateTxAddresses_Branches(t *testing.T) {
	if !ValidateTxAddresses(&Tx{Type: TxTypeTransferByZk}) {
		t.Fatal("non-UserContent should return true")
	}
	if ValidateTxAddresses(&Tx{Type: TxTypeUserContent, ExtraInfo: "{invalid"}) {
		t.Fatal("invalid JSON extra_info should return false")
	}
	otherExtra, _ := json.Marshal(UserContent{Type: TransactionExtraInfoGiveCoffee})
	if !ValidateTxAddresses(&Tx{Type: TxTypeUserContent, ExtraInfo: string(otherExtra), Recipient: "anything"}) {
		t.Fatal("content type not requiring validation should return true")
	}
	feedExtra, _ := json.Marshal(UserContent{Type: TransactionExtraInfoDonationCampaignFeed})
	if ValidateTxAddresses(&Tx{Type: TxTypeUserContent, ExtraInfo: string(feedExtra), Recipient: "0OIl"}) {
		t.Fatal("non-base58 recipient should return false")
	}
	if ValidateTxAddresses(&Tx{Type: TxTypeUserContent, ExtraInfo: string(feedExtra), Recipient: base58.Encode([]byte{1, 2, 3})}) {
		t.Fatal("wrong-length recipient should return false")
	}
}

func TestUnit_Convert_And_ExtraInfo(t *testing.T) {
	if Uint256ToString(nil) != "0" {
		t.Fatal("Uint256ToString(nil) should be 0")
	}
	if Uint256ToString(uint256.NewInt(42)) != "42" {
		t.Fatal("Uint256ToString(42) should be 42")
	}
	if !Uint256FromString("").IsZero() {
		t.Fatal("Uint256FromString('') should be 0")
	}
	if Uint256FromString("123456").Uint64() != 123456 {
		t.Fatal("Uint256FromString('123456') mismatch")
	}
	if Uint256FromString("not-a-number") != nil {
		t.Fatal("Uint256FromString invalid should return nil")
	}

	tx := &Tx{
		Type:      TxTypeTransferByZk,
		Sender:    "s",
		Recipient: "r",
		Amount:    uint256.NewInt(99),
		Timestamp: 1700000000,
		TextData:  "hi",
		Nonce:     5,
		ExtraInfo: `{"k":"v"}`,
		ZkProof:   "p",
		ZkPub:     "u",
	}
	protoSig := ToProtoSigTx(&SignedTx{Tx: tx, Sig: "sig"})
	if protoSig.Signature != "sig" || protoSig.TxMsg.Amount != "99" || protoSig.TxMsg.ZkProof != "p" {
		t.Fatalf("unexpected ToProtoSigTx: %+v", protoSig)
	}

	acc := FromProtoAccount(&mmnpb.GetAccountResponse{Address: "a", Balance: "500", Nonce: 7})
	if acc.Address != "a" || acc.Balance.Uint64() != 500 || acc.Nonce != 7 {
		t.Fatalf("unexpected FromProtoAccount: %+v", acc)
	}

	s, err := SerializeTxExtraInfo(nil)
	if err != nil || s != "" {
		t.Fatalf("SerializeTxExtraInfo(nil) got %q, %v", s, err)
	}
	s, err = SerializeTxExtraInfo(map[string]string{"a": "b"})
	if err != nil || s != `{"a":"b"}` {
		t.Fatalf("SerializeTxExtraInfo got %q, %v", s, err)
	}

	m, err := DeserializeTxExtraInfo("")
	if err != nil || m != nil {
		t.Fatalf("DeserializeTxExtraInfo('') got %+v, %v", m, err)
	}
	m, err = DeserializeTxExtraInfo(`{"a":"b"}`)
	if err != nil || m["a"] != "b" {
		t.Fatalf("DeserializeTxExtraInfo valid got %+v, %v", m, err)
	}
	if _, err := DeserializeTxExtraInfo("{broken"); err == nil {
		t.Fatal("expected error from DeserializeTxExtraInfo invalid json")
	}

	info := &TxInfo{ExtraInfo: `{"x":"y"}`}
	extra, err := info.DeserializedExtraInfo()
	if err != nil || extra["x"] != "y" {
		t.Fatalf("TxInfo.DeserializedExtraInfo got %+v, %v", extra, err)
	}
}
