package client

import (
	"github.com/holiman/uint256"
	proto "github.com/mezonai/mmn-sdk/go-sdk/proto"
)

func ToProtoTx(tx *Tx) *proto.TxMsg {
	return &proto.TxMsg{
		Type:      int32(tx.Type),
		Sender:    tx.Sender,
		Recipient: tx.Recipient,
		Amount:    Uint256ToString(tx.Amount),
		Nonce:     tx.Nonce,
		TextData:  tx.TextData,
		Timestamp: tx.Timestamp,
		ExtraInfo: tx.ExtraInfo,
		ZkProof:   tx.ZkProof,
		ZkPub:     tx.ZkPub,
	}
}

func ToProtoSigTx(tx *SignedTx) *proto.SignedTxMsg {
	return &proto.SignedTxMsg{
		TxMsg:     ToProtoTx(tx.Tx),
		Signature: tx.Sig,
	}
}

func FromProtoAccount(acc *proto.GetAccountResponse) Account {
	return Account{
		Address: acc.Address,
		Balance: Uint256FromString(acc.Balance),
		Nonce:   acc.Nonce,
	}
}

func Uint256ToString(value *uint256.Int) string {
	if value == nil {
		return "0"
	}
	return value.String()
}

func Uint256FromString(value string) *uint256.Int {
	if value == "" {
		return uint256.NewInt(0)
	}
	amount, err := uint256.FromDecimal(value)
	if err != nil {
		return nil
	}
	return amount
}
