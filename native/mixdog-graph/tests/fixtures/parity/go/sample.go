// Parity fixture: declaration and import shapes the graph reports for Go.
package sample

import "fmt"

import (
	"errors"
	"strings"

	"golang.org/x/sync/errgroup"
)

type Store struct {
	Name string
	size int
}

type Reader interface {
	Read(key string) (string, error)
}

type Alias = Store

type (
	Pair  struct{ A, B int }
	Count int
)

const Limit = 10

var ErrMissing = errors.New("missing")

func New(name string) *Store {
	return &Store{Name: name}
}

func (s *Store) Read(key string) (string, error) {
	if strings.TrimSpace(key) == "" {
		return "", ErrMissing
	}
	return fmt.Sprintf("%s/%s", s.Name, key), nil
}

func (s Store) Size() int {
	var group errgroup.Group
	_ = group
	return s.size
}
