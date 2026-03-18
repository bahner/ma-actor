.PHONY: build serve clean distclean

ACTOR_RS := $(shell find src -type f -name '*.rs')
DID_MA_RS := $(shell find ../rust-ma/src -type f -name '*.rs')
BUILD_INPUTS := Cargo.toml Cargo.lock ../rust-ma/Cargo.toml ../rust-ma/Cargo.lock $(ACTOR_RS) $(DID_MA_RS)

PKG_STAMP := www/pkg/.stamp


build: $(PKG_STAMP)

$(PKG_STAMP): $(BUILD_INPUTS)
	wasm-pack build --target web --out-dir www/pkg
	touch $(PKG_STAMP)

serve: build
	cd www && python3 -m http.server 8081

clean:
	rm -rf www/pkg

distclean: clean
	cargo clean
