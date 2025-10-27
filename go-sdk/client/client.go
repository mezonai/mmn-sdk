package client

import (
	"context"
	"fmt"

	"github.com/holiman/uint256"
	mmnpb "github.com/mezonai/mmn-sdk/go-sdk/proto"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
)

type Config struct {
	Endpoint string
	UseTLS   bool
}

type MmnClient struct {
	cfg          Config
	conn         *grpc.ClientConn
	healthClient mmnpb.HealthServiceClient
	txClient     mmnpb.TxServiceClient
	accClient    mmnpb.AccountServiceClient
}

func NewClient(cfg Config) (*MmnClient, error) {
	var creds credentials.TransportCredentials

	if cfg.UseTLS {
		creds = credentials.NewTLS(nil)
	} else {
		creds = insecure.NewCredentials()
	}

	conn, err := grpc.NewClient(
		cfg.Endpoint,
		grpc.WithTransportCredentials(creds),
	)

	if err != nil {
		return nil, err
	}

	return &MmnClient{
		cfg:          cfg,
		conn:         conn,
		healthClient: mmnpb.NewHealthServiceClient(conn),
		txClient:     mmnpb.NewTxServiceClient(conn),
		accClient:    mmnpb.NewAccountServiceClient(conn),
	}, nil
}

func (c *MmnClient) CheckHealth(ctx context.Context) (*mmnpb.HealthCheckResponse, error) {
	health, err := c.healthClient.Check(ctx, &mmnpb.Empty{})
	if err != nil {
		return nil, err
	}

	return health, nil
}

func (c *MmnClient) AddTx(ctx context.Context, tx SignedTx) (AddTxResponse, error) {
	txMsg := ToProtoSigTx(&tx)
	res, err := c.txClient.AddTx(ctx, txMsg)
	if err != nil {
		return AddTxResponse{}, err
	}
	if !res.Ok {
		return AddTxResponse{}, fmt.Errorf("add-tx failed: %s", res.Error)
	}

	return AddTxResponse{
		Ok:     res.Ok,
		TxHash: res.TxHash,
		Error:  res.Error,
	}, nil
}

func (c *MmnClient) GetAccount(ctx context.Context, addr string) (Account, error) {
	res, err := c.accClient.GetAccount(ctx, &mmnpb.GetAccountRequest{Address: addr})
	if err != nil {
		return Account{Address: addr, Balance: uint256.NewInt(0), Nonce: 0}, err
	}

	return FromProtoAccount(res), nil
}

func (c *MmnClient) SubscribeTransactionStatus(ctx context.Context) (mmnpb.TxService_SubscribeTransactionStatusClient, error) {
	stream, err := c.txClient.SubscribeTransactionStatus(ctx, &mmnpb.SubscribeTransactionStatusRequest{})
	if err != nil {
		fmt.Printf("SubscribeTransactionStatus error: %v", err)
		return nil, err
	}

	return stream, nil
}

func (c *MmnClient) GetTxByHash(ctx context.Context, txHash string) (TxInfo, error) {
	res, err := c.txClient.GetTxByHash(ctx, &mmnpb.GetTxByHashRequest{TxHash: txHash})
	if err != nil {
		return TxInfo{}, err
	}
	if res.Error != "" {
		return TxInfo{}, fmt.Errorf("get-tx-by-hash failed: %s", res.Error)
	}

	return TxInfo{
		Sender:    res.Tx.Sender,
		Recipient: res.Tx.Recipient,
		Amount:    Uint256FromString(res.Tx.Amount),
		Timestamp: res.Tx.Timestamp,
		TextData:  res.Tx.TextData,
		Nonce:     res.Tx.Nonce,
		Slot:      res.Tx.Slot,
		Blockhash: res.Tx.Blockhash,
		Status:    int32(res.Tx.Status),
		ErrMsg:    res.Tx.ErrMsg,
		ExtraInfo: res.Tx.ExtraInfo,
		TxHash:    res.Tx.TxHash,
	}, nil
}

func (c *MmnClient) GetCurrentNonce(ctx context.Context, addr string, tag string) (uint64, error) {
	res, err := c.accClient.GetCurrentNonce(ctx, &mmnpb.GetCurrentNonceRequest{Address: addr, Tag: tag})
	if err != nil {
		return 0, err
	}

	return res.Nonce, nil
}

func (c *MmnClient) Conn() *grpc.ClientConn {
	return c.conn
}

// Close closes the gRPC connection
func (c *MmnClient) Close() error {
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}
