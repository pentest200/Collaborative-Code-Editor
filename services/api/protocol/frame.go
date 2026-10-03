package protocol

import (
	"encoding/binary"
	"errors"
)

const Version byte = 1
const HeaderBytes = 6
const MaxSequence uint64 = 9223372036854775807

type Direction int

const (
	Client Direction = iota
	Server
)

type Frame struct {
	Type byte
	Body []byte
}

func Decode(input []byte, direction Direction) (Frame, error) {
	if len(input) < HeaderBytes {
		return Frame{}, errors.New("truncated header")
	}
	if input[0] != Version {
		return Frame{}, errors.New("unsupported version")
	}
	typ := input[1]
	min, max, ok := limits(typ)
	if !ok {
		return Frame{}, errors.New("unknown type")
	}
	if !allowed(typ, direction) {
		return Frame{}, errors.New("wrong direction")
	}
	length := uint64(binary.BigEndian.Uint32(input[2:6]))
	if length < uint64(min) || length > uint64(max) || uint64(len(input)) != HeaderBytes+length {
		return Frame{}, errors.New("invalid length")
	}
	body := input[6:]
	if typ == 3 || typ == 5 || typ == 6 {
		if binary.BigEndian.Uint64(body[:8]) > MaxSequence {
			return Frame{}, errors.New("sequence exceeds signed int64")
		}
	}
	if typ == 3 {
		vectorLength := uint64(binary.BigEndian.Uint32(body[8:12]))
		if vectorLength > 65536 || uint64(len(body)) < 16+vectorLength {
			return Frame{}, errors.New("invalid vector length")
		}
		updateLength := uint64(binary.BigEndian.Uint32(body[12+vectorLength : 16+vectorLength]))
		if updateLength > 2097152 || uint64(len(body)) != 16+vectorLength+updateLength {
			return Frame{}, errors.New("invalid update length")
		}
	}
	return Frame{Type: typ, Body: body}, nil
}

func limits(typ byte) (int, int, bool) {
	switch typ {
	case 1, 8:
		return 2, 4096, true
	case 2:
		return 0, 65536, true
	case 3:
		return 16, 16 + 65536 + 2097152, true
	case 4, 9:
		return 65, 64 + 524288, true
	case 5:
		return 73, 72 + 524288, true
	case 6:
		return 72, 72, true
	case 7:
		return 1, 2048, true
	default:
		return 0, 0, false
	}
}

func allowed(typ byte, direction Direction) bool {
	if direction == Client {
		return typ == 2 || typ == 4 || typ == 7
	}
	return typ == 1 || typ == 3 || typ == 5 || typ == 6 || typ == 7 || typ == 8 || typ == 9
}
