//! Known vectors for the filters and the security handler of mixdog-pdf-codec.
//!
//! The encoded bytes below were produced by programs that are not the code under test, and each is checked here
//! against the plain bytes it must decode to:
//! - Flate: Python `zlib` (levels 9 and 0, and a full flush between two pieces for a stream of several blocks).
//! - LZW: the PDF specification's example, and an encoder written from the specification (EarlyChange 1 and 0) whose
//!   EarlyChange 1 output pypdf's decoder reads back unchanged.
//! - ASCII85: Python `base64.a85encode`.
//! - Predictors: row encoders written from the PNG and TIFF specifications.
//! - Encryption: pypdf 6.13.2 wrote one document per revision (RC4-40, RC4-128, AES-128, AES-256 revision 5 and 6)
//!   with the user password empty and again with the user password `user`, the owner password `owner`; the values of
//!   its `Encrypt` dictionary, the encrypted `Title` string of object 1 and the encrypted content stream of object 5
//!   are copied here.
//!
//! The inputs are small pseudo-random sequences (`lcg`) so the plain bytes need not be stored.

use mixdog_pdf_codec::predictor::{self, PredictorParams};
use mixdog_pdf_codec::security::{
    CipherTransformFactory, CryptFilter, CryptFilterMethod, EncryptDict, SecurityError, INCORRECT_PASSWORD,
    NEED_PASSWORD,
};
use mixdog_pdf_codec::{ascii85, asciihex, decode_chain, flate, lzw, rc4, runlength, Filter};

fn hex(text: &str) -> Vec<u8> {
    (0..text.len() / 2).map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).unwrap()).collect()
}

fn lcg(n: usize, alphabet: &[u8], seed: u64) -> Vec<u8> {
    let mut x = seed;
    (0..n)
        .map(|_| {
            x = (x * 1_103_515_245 + 12_345) & 0x7fff_ffff;
            alphabet[((x >> 16) as usize) % alphabet.len()]
        })
        .collect()
}

fn same(got: &[u8], want: &[u8], what: &str) {
    let first = got.iter().zip(want).position(|(a, b)| a != b);
    assert!(
        got == want,
        "{what}: got {} bytes, want {} bytes, first difference at {first:?}",
        got.len(),
        want.len()
    );
}

const NO_LIMIT: usize = usize::MAX;

const FLATE_HELLO: &str = "78dacb48cdc9c957c8402701680308b1";
const FLATE_DYNAMIC: &str = "78da1d954b9203310843cf0ac6808df9dc7f157536539549ba0dd2939c5b63aa22345f8fd0cda2b943b573d77a7624d64cfbb9dc97de51cd7b79cc564f5eadb74fdcdcb2da46a2f0107e37649eb97d5925ddd8d78c9ed85e0b0f886b449c683c6a2d2d71a8ce3b13f83e8fbff4d867e97b45e9c766d561be2dfa967a076f3b8e235f5fe5b57947c63d5bbdd659a32f6fe4d39e139469ed2f5eb58bac9c59e9a2eb952bcdb9311edf163b8eb6d4c92a7f1763cb9ec8cd64e7240ff7e9db418f22ec1a8d3abe2d79f7b891bdc374ebaef576af1518a989b6c75056f7d27becb05f49c619ebdb71fbe0fd6dd8dd9e936315d66d7a7a112fe791812b071acf5972678db3b6cfbd2107729f3a4565e72dacc069914aec10e59570496932efa49d1a909a55de1806532a71d8a574c49d7098043f9b8d41de54b099dc587629f40a6103c5760981321c724215a358b40a2cccde9bc592f71598bb4a4230b83c1a9bae122defcd4f7dafbdcfeec3778f00a0ec2186f25150e84d42d8159f6d091cd8ee30b8007eab0214fa2317be559071251805a2565abcaab16f1b7853d8f10cac81a0fb0c2eca31d590bb69058cddc995f5f24c3748e779d88b1cb36fbd9372b89f609954d74fa1923903bd21190e5d548b8ba11a97593ce223d88b8f0675b7dc0f9aa4061584fc1c1c08c6f2bc34deb2d31b28cf9174e0e270c374a0db22ac9b53d04bc58a7c7658594aef1b3ce104c0f212c0c1534cfb782259976d805b09f126c8620ca0089f683054a7eaa5018b5791a3eb7892613926060e30e1efbc34c706d3b46108e27f41c676c72eeb9d167e091d17ce326f55dd177041d369767404105f7a0ca1c1b4be03d2ade5177e2b00dd55d6b0ba1b7b5674133e0406a254640a5be37557fd19ddb3ce0b0227be925627f225b19d144bcaed332812180d862f68f6eb32f3a6117b3646861859885e1d330c66344d8113300427b1b0fc7b5e8ff60b7c033508a140f07d353279cccf03a80b290cf7054ab24eef1d6288be440a6460702dcb031da486c9d618237ecf51359ca0d9002e5ed47d65d026e700724c36c54057df4690ac75efba4e397d2198439053288e2616d81d731e5e73c9e28b72de8639d72e334c85c583fa48386c7dde8dbbdc64a3426ff6e215369548f1031ec320e6e8936528209141f73227267c185462f2a16840232af1a0f972208dc21f545cc24d1308824421cc0339399f23198da63a6378aa1ec832d140cb5fae70c4683fc178bc06d4bce1f85e544809ccab4f6485e6f1fdbcc78e3a7e83b2200470adfd0176d0db86a5912074daa33cf024516e44da548a5b83e42a663c5f9867e32230588a56c4f9b85ae05de00e09ad69a81f4f17f4b3f996179cbe84165abbf1e7de15feb5c5bf0d7767bb163a0226edd5a817bdbe8001215b56914e9c1b579e3f5c1ebcbe3ba851e007893fd9dccd75013d42b5387514ffc44524e14d0200915fd6b56d1837077af3f2c917df14405bc380b2db2d5c11b873d1afb82150fe19053ee4a014ced36fbd5a5ec01bc5e5ce41b8c62e7d28c2d39d2897de16a54328c4fd03e43a3180";
const FLATE_STORED: &str = "7801011100eeff73746f72656420626c6f636b20646174613bcd0677";
const FLATE_MULTI: &str = "78da1490d11500200802671510dc7f82e8f593a61c944012b5f1ede27a12de5d0e9c05d3576376dd9e45f62ea6cff853d1d82db9c9c2b9604687f1182b53035621c78efd02590e96315281ee94e3d95be8b7a61674bd56d8965c56321bd669e127cee0238ef2d486e9e908b45768a8cc54ba91aaacef66f9976aa221b63d15affd38d6a0d5ccd8266ab03ade41c5fa1f6cc4ba33cc52fd000000ffff1d90010ec03008021f0d2af0fad1254dd6383dce1e330ae8d5def6d8391942cb3dbe579e0179589ea27bb5041bca99630e4422f6b350b6c3b352d8be25a65c9936d66f70e0ceb0d730b979a0f46f8940294d1c958d37a3d370b7f8a9a3f01406b56ddef1752d490b3858baba68641395c82d6b92ad675dcf1c6bfdf65189f561deaaddada0c9a4bd4be7bd41132e3fbef10dde0f454700f0";
const LZW_BIG_EARLY1: &str = "80184c4618140cc8633241208633118a0f0c84c26066188434c90681422186188c38c70583c2a051731432210890ca6110e8498e35268a41e4b148243e690b99c7e191e9740a39268742e630386c3a4b073245e3f098cd328b2e8442a93118fc826328884a693269ecfa972f9d52a835f8f5125d1688ca68d16b3c5e6b069754e81269259e072fa4c4e95738e4d6853493cfabd23a151e831986c731335994ca47248bcca3f779a44aa7139dd46dd6c89436a125b44aeaf9fa6c3e65a0965169116a1e4eb750c152a231c89466fb149cc8b6904c4dde2735c9d47536d9ee6a0b8cb4cd28370a4c2b49cbc84fe892da9466a17bc44de9746e45debfc1b7703718ada41a91b2b7556893792ca30f3ac5f87853fa5cb75d9f87d924366a3f47b682aee90af098af28a274c0afa8d31eceb8aceb70ef37ae6a34a3a60aac0c8d290a8ac2dfa76de40edc3f68b35887c28fcb54bead292402fa3c713bb2f7378c6b2c95b7ce2c50b0a7c90a7ef3c44dfb508da9ca2b10b93d4af360b02a4b8aaecda168daeccac9d01324e5ab099aa6e6b6edc27af6b7ec7250c5366feb16dfbca8839c89b4133308b8ab6cb36cb7a0a97acc91c7a913af0eaca8942ca92d2a7c0ca14a31d3a93c382f6b04c3c028aa58ac2e703acf40a8e9fb9cae43cb9378cf31096298c8b68d7b80c5ae303b72e530b48b84a7356c52db4eaaea6b1ecf256cd2594acee96bf73d2be913d34dbf2c9afd02356f551ea2d34f126e9f282f4ba5553b2c645ab843aaf4494bd814bbdae2a30c6cd8d0c94c8b12e6bd2e1328bab08a440d1d3fb05240d32b0b52b118c65052cacac96d842eb53633d31309ba8a3321624572047298cb50cb2cec60cc64309828cf833d4c2d4f0d2eba32700ab69e5ad022e2cf4fb142a72d5fcb1af2b3cff5f3c89c2a4f35874e3a90f33095498cbd62e760cb161af8236abb40cdb22a84698e592d2c9d9ccdd824cd91aa2fa6229da78ebd9f645eac5516a1d8f2d2fb13cbf104da9d36cf6b22fb364a7ebd77bec9e3fb4ee3eee5d0d9459412f4d4c130926773aab69e1ab4ccd313a719a4695ab6fa67caed270c5bd4c44aa2638da5a2b7e73a052ab2b38ae27b5dbb98050cba5bf2650d0f3019dc55735a6dac170936ed66775838307ce8f3f2496f4e85eff553e51a451444850dd2758270b86e78bb88f2ce2ba2acb44dcd3506b0b9b212f3d8f09a9298edf212773adbf7d7044cb1a9bc9c39dae7aa04e6d677126c2fbca6da82fcfed7953aebe44373f2b2ec50b02ad0bf51f50e75c9d45bac62e3d14c6c627d49435f7e6a2d1d161648588c01a36a88a4c014c376901fc26774ac40832014acd4e042b1648d049b23a4e2d9d8792731c598d3aa643ab78d59b9494d260a9363dcb80e62658405b18db3a796700c714e614b892f964668794b31f060f0f0cb13c33a490eac2c3d458d59a0a24ea84e2a1623c83db51da348c4da61995a84cd7dbc264301502b3c488665e59fb6fab11201aa3c09a5a6b754dad00aa2da32e6a92bb99394b990a269590ec4fca043104c1659e174d02d113154670de02a068d0eb9dfa14374cdd701378f0454ed2233dcdedcc91e35e6a944a5c6fc7cd25b603c2cf4cc31b79e80a13c164b89d16b96b31a9a5d7388914af9213222706b8d331687a670ab3235d852dec9b5366a3dd83546d4938d03274ad0964b30f2f332cb13764587e12caef80e8423744746314d5ea8a42a7bdd74026fa6093c20c4d0a86173573c896235bc95670d1c845b51246e4d1762e4f1a0ea184ad3d0aa3d87c0b14fc155837141344ac4fe8657bcea5d0da1133fa9607d164c3a8f4c80a69fc47accd0499824a404";
const LZW_BIG_EARLY0: &str = "80184c4618140cc8633241208633118a0f0c84c26066188434c90681422186188c38c70583c2a051731432210890ca6110e8498e35268a41e4b148243e690b99c7e191e9740a39268742e630386c3a4b073245e3f098cd328b2e8442a93118fc826328884a693269ecfa972f9d52a835f8f5125d1688ca68d16b3c5e6b069754e81269259e072fa4c4e95738e4d6853493cfabd23a151e831986c731335994ca47248bcca3f779a44aa7139dd46dd6c89436a125b44aeaf9fa6c3e65a0965169116a1e4eb750c152a231c89466fb149cc8b6904c4dde2735c9d47536d9ee6a0b8cb4cd28370a4c2b49cbc84fe892da9466a17bc44de9746e45debfc1b7703718ada41a91b2b7556893792ca30f3ac5f87853fa5cb75d9f87d924366a3f47b7055dd215e1315e5144e9815f51a63d9d7159d6e1de6f5cd469474c1558191a52151585bf4edbc81db87ed166b10f851f96a97d5a524805f478e27765ee6f18d6592b6f9c58a1614f9214fde7889bf6a11b53945621727a95e6c1605497155d9b42d1b5d99593a02649cb5613354dcd6ddb84f5ed6fd8e4a18a6cdfd62dbf7951073913682666117156d966d96f4152f599238f52275e1d59512859525a54f819429463a75278705ed60987805154b1585ce0759e8151d3f7395c879726f19e6212c531916d1af7018b5c6076e5ca616917094e6ad8a5b69d55d4d63d9e4ad9a4b2959dd2d7ee7a57d227a69b7e5935fa046adeaa3d45a69e24dd3e505e974aaa7658c8b5708755e89297b02977b5c54618d9b1a192991625cd7a5c2651756114881a3a7f60a481a65616a562318ca0a5959592db085d6a6c67a6261375146642c48ae408e53196a19659d8c198c86130519f067a985a9e1a5d7464e0156d3cb5a045c59e9f62854e5abf9635e5679febe79138549e6b0e9c7521e6612a93197ac5cec1962c35f046d576819b645508d31cb25a593b399bb0499b23545f4c453b4f1d7b3ec8bd58aa2d43b1e5a5f62797e209b53a6d9ed645f66c94fd7aef7d93c7f69dc7ddcba1b28b2825e9a9826124cee7556d3c356999a6274e3348d2b56df4cf95da4e18b7a9889544c71b4b456fce740a55656715c4f6bb77300a1974b7e4ca1a1e6033b8aae6b4db582e126ddacceeb07060f9d1e7e492de9d0bdfeaa7ca348a28890a1ba4eb04e170dcf17711e59c574559689b9a6a0d61736425e7b1e1352531dbe424ee75b7efae08996353793873b5cf5409cdacee24d85f794db505f9fdaf2a75d7c886e7e565d8a16055a17ea3ea1ceb93a8b758c5c7a298d8c5f5250d7df9a8b4745859216230068daa229300530dda407f099dd2b1020c8052b353810ac59234126c8e938b6761e49cc716634ea990eade3566e52534982a4d8f72e03989961016c636ce9e59c031c539852e24be5919a1e52cc7c183c3c32c4f0ce9243ab0b0f516356682893aa138a8588f20f6d4768d23136986656a1335f6f0990c0540acf1221997967edbeac44806a8f026969add536b402a8b68cb9aa4aee64e52e64289a5643b13f2810c4130596785d340b444c5519c3780a81a343ae77e850dd3375c04de3c1153b488cf737b732478d79aa512971bf1f3496d80f0b3d330c6de7a0284f0592e2745ae5acc6a6975ce22452be484c889c1ae34cc5a1e99c2acc8d7614b7b26d4d9a8f760d51b524e340c9d2b42592cc3cbcccb2c4dd9161f84b2bbe03a108dd11d18c5357aa290a9ef75d009be9824f0831342a185cd5cf22588d6f2559c3472116d4491b9345d8b93c683a8612b4f42a8f61f02c53f05560dc504d12b13fa195ef3a97436844cfea581f45930ea3d32029a7f11eb33412660929010";
const LZW_NO_EOD: &str = "80184c4638141207058440c0";
const A85_PLAIN_HEX: &str = "48656c6c6f2c20576f726c6421200000000020616e64206d6f7265206279746573203132333435";
const PNG_ENCODED: &str = "00bf36eda6f7bac2c81ff655ac0185d86b27c02b4b0e831b87c602c6a37e07a1dd36defa1cd83403ede0f257b0e3efb3dc03aa3604c6a37ee8a14735defad0d83304c6a37e28badd3600faedd833";
const PNG_PLAIN: &str = "bf36eda6f7bac2c81ff655ac85d86bac9896f7a619122ddf4b7be9b339732d84132e0513121d66b9db4f62620d4bdd46d8c0e4c07c2b97400767b5799e6362c61d08cd1d01848dac";
const PNG_ENCODED_ZLIB: &str = "78da63d86ff676d9f75d874ec87f0b5dc3d87a235bfd80b6375fb374fb31a6638bebd817de35bbf74be68609f3db079fc2373c7ebff90ef32a3316a0cc8b85eea6f77e5db8610ce268ecba6bc6f0ebed0d63005de72a1f";
const TIFF8_ENCODED: &str = "3deac0eba731c58cb7401804038c3e2ba68ff4c9d527123dc92fbb6ba4ef2306f20f0b76";
const TIFF8_PLAIN: &str = "3deac02891f1ed1da82d35ac038c3e2e32cd22fba2490ddfc92fbb34d3aa57d99c66e412";
const TIFF16_ENCODED: &str = "bb9e93a96e8a83ca073cfd39814010b049c43ba1607da08e";
const TIFF16_PLAIN: &str = "bb9e93a92a281773316414ac814010b0cb044c512b81ecdf";
const TIFF4_ENCODED: &str = "967660576670176670";
const TIFF4_PLAIN: &str = "9f6c205c28f018e4b0";
const TIFF2_ENCODED: &str = "e4107140";
const TIFF2_PLAIN: &str = "e2307480";
const TIFF1_ENCODED: &str = "c480c480";
const TIFF1_PLAIN: &str = "87008700";
const A85_TEXT: &str = "87cURD_*#4DfTZ)+Wpab!!\"-MDIal,DfTD3@X3',F!*1m1Ggr~>";
const A85_PREFIXES: [&str; 20] = ["9`", "9jn", "9jqo", "9jqo^", "9jqo^B`", "9jqo^Bla", "9jqo^BlbB", "9jqo^BlbD-", "9jqo^BlbD-B`", "9jqo^BlbD-Bla", "9jqo^BlbD-Ble@", "9jqo^BlbD-BleB1", "9jqo^BlbD-BleB1D?", "9jqo^BlbD-BleB1DJ&", "9jqo^BlbD-BleB1DJ+(", "9jqo^BlbD-BleB1DJ+*+", "9jqo^BlbD-BleB1DJ+*+Er", "9jqo^BlbD-BleB1DJ+*+F(b", "9jqo^BlbD-BleB1DJ+*+F(f+", "9jqo^BlbD-BleB1DJ+*+F(f,q"];
const LZW_NO_EOD_CODES: usize = 10;

// ---------------------------------------------------------------------------------------------------------------
// Flate

#[test]
fn flate_fixed_huffman_block() {
    let got = flate::inflate(&hex(FLATE_HELLO), NO_LIMIT).unwrap();
    assert_eq!(got, b"hello hello hello hello");
}

#[test]
fn flate_dynamic_huffman_block() {
    let want = lcg(2000, b"abcdefghijklmnop", 12345);
    let got = flate::inflate(&hex(FLATE_DYNAMIC), NO_LIMIT).unwrap();
    same(&got, &want, "dynamic block");
}

#[test]
fn flate_stored_block() {
    let got = flate::inflate(&hex(FLATE_STORED), NO_LIMIT).unwrap();
    assert_eq!(got, b"stored block data");
}

#[test]
fn flate_several_blocks_with_an_empty_stored_block() {
    let mut want = lcg(300, b"abcdefgh", 1);
    want.extend(lcg(300, b"stuvwxyz", 2));
    let got = flate::inflate(&hex(FLATE_MULTI), NO_LIMIT).unwrap();
    same(&got, &want, "multi block");
}

#[test]
fn flate_truncated_stream_gives_what_was_decoded() {
    let want = lcg(2000, b"abcdefghijklmnop", 12345);
    let full = hex(FLATE_DYNAMIC);
    for cut in [30, 200, 1000] {
        let got = flate::inflate(&full[..full.len() - cut], NO_LIMIT).unwrap();
        assert!(!got.is_empty() && got.len() < want.len(), "cut {cut}: {} bytes", got.len());
        same(&got, &want[..got.len()], "truncated prefix");
    }
}

#[test]
fn flate_missing_checksum_gives_everything() {
    let want = lcg(2000, b"abcdefghijklmnop", 12345);
    let full = hex(FLATE_DYNAMIC);
    let got = flate::inflate(&full[..full.len() - 4], NO_LIMIT).unwrap();
    same(&got, &want, "no adler32");
}

#[test]
fn flate_corrupt_block_keeps_the_earlier_blocks() {
    // A stored block "abc", then a block header of the reserved type 3.
    let data = [0x78, 0x01, 0x00, 0x03, 0x00, 0xfc, 0xff, b'a', b'b', b'c', 0x07, 0x00, 0x00];
    assert_eq!(flate::inflate(&data, NO_LIMIT).unwrap(), b"abc");
}

#[test]
fn flate_corrupt_stored_length_keeps_the_earlier_blocks() {
    let data = [0x78, 0x01, 0x00, 0x01, 0x00, 0xfe, 0xff, b'x', 0x01, 0x05, 0x00, 0x00, 0x00, b'y'];
    assert_eq!(flate::inflate(&data, NO_LIMIT).unwrap(), b"x");
}

#[test]
fn flate_stored_block_cut_short_is_padded_with_zeros() {
    let data = [0x78, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xff, b'a', b'b'];
    assert_eq!(flate::inflate(&data, NO_LIMIT).unwrap(), [b'a', b'b', 0, 0, 0]);
}

#[test]
fn flate_corrupt_huffman_data_stops_at_the_damage() {
    // A fixed block: the length symbol 259, then the distance code 31 that no distance uses.
    let data = [0x78, 0x01, 0x03, 0xff, 0xff, 0xff];
    let got = flate::inflate(&data, NO_LIMIT).unwrap();
    assert!(got.is_empty());
}

#[test]
fn flate_header_errors() {
    assert!(flate::inflate(&[], NO_LIMIT).is_err());
    assert!(flate::inflate(&[0x78], NO_LIMIT).is_err());
    assert!(flate::inflate(&[0x00, 0x00], NO_LIMIT).is_err(), "method 0");
    assert!(flate::inflate(&[0x78, 0x00], NO_LIMIT).is_err(), "bad check bits");
    assert!(flate::inflate(&[0x78, 0xbb], NO_LIMIT).is_err(), "preset dictionary");
}

#[test]
fn flate_output_limit() {
    let want = lcg(2000, b"abcdefghijklmnop", 12345);
    let got = flate::inflate(&hex(FLATE_DYNAMIC), 100).unwrap();
    same(&got, &want[..100], "limit 100");
    assert!(flate::inflate(&hex(FLATE_DYNAMIC), 0).unwrap().is_empty());
}

// ---------------------------------------------------------------------------------------------------------------
// LZW

#[test]
fn lzw_specification_example() {
    let got = lzw::decode(&[0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01], 1, NO_LIMIT);
    assert_eq!(got, [45, 45, 45, 45, 45, 65, 45, 45, 45, 66]);
}

#[test]
fn lzw_code_width_grows_with_early_change_one() {
    let want = lcg(4000, b"abcd", 99);
    let got = lzw::decode(&hex(LZW_BIG_EARLY1), 1, NO_LIMIT);
    same(&got, &want, "early change 1");
}

#[test]
fn lzw_code_width_grows_with_early_change_zero() {
    let want = lcg(4000, b"abcd", 99);
    let got = lzw::decode(&hex(LZW_BIG_EARLY0), 0, NO_LIMIT);
    same(&got, &want, "early change 0");
}

#[test]
fn lzw_wrong_early_change_does_not_decode_the_same_data() {
    let want = lcg(4000, b"abcd", 99);
    let got = lzw::decode(&hex(LZW_BIG_EARLY1), 0, NO_LIMIT);
    assert_ne!(got, want);
}

#[test]
fn lzw_without_end_of_data_reads_zeros_to_the_end_of_the_block() {
    // pdf.js decodes 512 codes at a time and the codes missing at the end read as the byte 0.
    let got = lzw::decode(&hex(LZW_NO_EOD), 1, NO_LIMIT);
    let plain = b"abcabcabcabcabcabc";
    assert_eq!(got.len(), plain.len() + (512 - LZW_NO_EOD_CODES));
    assert_eq!(&got[..plain.len()], plain);
    assert!(got[plain.len()..].iter().all(|&b| b == 0));
}

#[test]
fn lzw_output_limit_and_empty_input() {
    let want = lcg(4000, b"abcd", 99);
    let got = lzw::decode(&hex(LZW_BIG_EARLY1), 1, 1000);
    same(&got, &want[..1000], "limit 1000");
    assert!(lzw::decode(&[], 1, NO_LIMIT).len() <= 512);
}

// ---------------------------------------------------------------------------------------------------------------
// ASCII85, ASCIIHex, RunLength

#[test]
fn ascii85_text_zero_groups_and_whitespace() {
    let want = hex(A85_PLAIN_HEX);
    assert_eq!(ascii85::decode(A85_TEXT.as_bytes(), NO_LIMIT), want);
    let spaced: Vec<u8> = A85_TEXT.bytes().flat_map(|b| [b, b'\n', b' ']).collect();
    assert_eq!(ascii85::decode(&spaced, NO_LIMIT), want);
    assert_eq!(ascii85::decode(b"zz~>", NO_LIMIT), [0u8; 8]);
}

#[test]
fn ascii85_partial_final_group_and_missing_terminator() {
    let plain = b"Man is distinguished";
    for n in 1..=plain.len() {
        let text = A85_PREFIXES[n - 1];
        assert_eq!(ascii85::decode(text.as_bytes(), NO_LIMIT), &plain[..n], "{n} bytes, no terminator");
        let ended = format!("{text}~>");
        assert_eq!(ascii85::decode(ended.as_bytes(), NO_LIMIT), &plain[..n], "{n} bytes");
    }
    assert_eq!(ascii85::decode(b"~>", NO_LIMIT), b"");
    assert_eq!(ascii85::decode(b"", NO_LIMIT), b"");
}

#[test]
fn ascii85_output_limit() {
    assert_eq!(ascii85::decode(b"9jqo^BlbD-~>", 6), b"Man is"[..6].to_vec());
}

#[test]
fn asciihex_digits_case_whitespace_and_odd_count() {
    assert_eq!(asciihex::decode(b"48656C6c6F>", NO_LIMIT), b"Hello");
    assert_eq!(asciihex::decode(b"48 65\n6C 6c\t6F>", NO_LIMIT), b"Hello");
    assert_eq!(asciihex::decode(b"48656C6C6F7>", NO_LIMIT), b"Hello\x70");
    assert_eq!(asciihex::decode(b"4x8y>", NO_LIMIT), b"\x48");
    assert_eq!(asciihex::decode(b"4865>6C", NO_LIMIT), b"He");
    // A lone digit at the end of an input with no `>` is dropped.
    assert_eq!(asciihex::decode(b"48656", NO_LIMIT), b"He");
    assert_eq!(asciihex::decode(b">", NO_LIMIT), b"");
    assert_eq!(asciihex::decode(b"48656C6C6F>", 3), b"Hel");
}

#[test]
fn runlength_literal_and_repeat_runs() {
    assert_eq!(runlength::decode(&[2, b'a', b'b', b'c', 254, b'x', 128, 9], NO_LIMIT), b"abcxxx");
    assert_eq!(runlength::decode(&[0, b'q', 129, b'z'], NO_LIMIT).len(), 1 + 128);
    assert_eq!(runlength::decode(&[], NO_LIMIT), b"");
    assert_eq!(runlength::decode(&[3], NO_LIMIT), b"");
}

#[test]
fn runlength_copy_cut_short_is_padded_and_limit_applies() {
    assert_eq!(runlength::decode(&[4, b'a', b'b'], NO_LIMIT), [b'a', b'b', 0, 0, 0]);
    assert_eq!(runlength::decode(&[253, b'k'], NO_LIMIT), b"kkkk");
    assert_eq!(runlength::decode(&[253, b'k', 253, b'j'], 6), b"kkkkjj");
}

// ---------------------------------------------------------------------------------------------------------------
// Predictors

fn params(predictor: i64, colors: i64, bits: i64, columns: i64) -> PredictorParams {
    PredictorParams { predictor, colors, bits_per_component: bits, columns }
}

#[test]
fn predictor_png_all_filter_types() {
    let got = predictor::decode(&hex(PNG_ENCODED), &params(15, 3, 8, 4), NO_LIMIT).unwrap();
    same(&got, &hex(PNG_PLAIN), "png");
    // The predictor number between 10 and 15 does not matter: each row has its own filter byte.
    let got = predictor::decode(&hex(PNG_ENCODED), &params(10, 3, 8, 4), NO_LIMIT).unwrap();
    same(&got, &hex(PNG_PLAIN), "png 10");
}

#[test]
fn predictor_png_cut_row_is_completed_with_zeros() {
    let encoded = hex(PNG_ENCODED);
    let plain = hex(PNG_PLAIN);
    let row = 12;
    // The data ends after 5 of the 12 bytes of the third row (filter type 2, Up).
    let cut = &encoded[..2 * (row + 1) + 1 + 5];
    let got = predictor::decode(cut, &params(15, 3, 8, 4), NO_LIMIT).unwrap();
    assert_eq!(got.len(), 3 * row);
    same(&got[..2 * row + 5], &plain[..2 * row + 5], "complete part");
    assert!(got[2 * row + 5..].iter().all(|&b| b == 0));
    // A filter byte with no row after it ends the data.
    let got = predictor::decode(&encoded[..2 * (row + 1) + 1], &params(15, 3, 8, 4), NO_LIMIT).unwrap();
    assert_eq!(got.len(), 2 * row);
}

#[test]
fn predictor_png_unknown_filter_byte_is_an_error() {
    let mut encoded = hex(PNG_ENCODED);
    encoded[13] = 9;
    assert!(predictor::decode(&encoded, &params(15, 3, 8, 4), NO_LIMIT).is_err());
}

#[test]
fn predictor_tiff_by_component_size() {
    let cases: [(&str, &str, PredictorParams); 5] = [
        (TIFF8_ENCODED, TIFF8_PLAIN, params(2, 3, 8, 4)),
        (TIFF16_ENCODED, TIFF16_PLAIN, params(2, 2, 16, 3)),
        (TIFF4_ENCODED, TIFF4_PLAIN, params(2, 1, 4, 5)),
        (TIFF2_ENCODED, TIFF2_PLAIN, params(2, 2, 2, 3)),
        (TIFF1_ENCODED, TIFF1_PLAIN, params(2, 1, 1, 11)),
    ];
    for (encoded, plain, p) in cases {
        let got = predictor::decode(&hex(encoded), &p, NO_LIMIT).unwrap();
        same(&got, &hex(plain), &format!("tiff bits {}", p.bits_per_component));
    }
}

#[test]
fn predictor_defaults_none_and_unsupported() {
    let data = [1u8, 2, 3, 4];
    assert_eq!(predictor::decode(&data, &params(0, 0, 0, 0), NO_LIMIT).unwrap(), data);
    assert_eq!(predictor::decode(&data, &params(1, 5, 5, 5), NO_LIMIT).unwrap(), data);
    assert!(predictor::decode(&data, &params(3, 1, 8, 1), NO_LIMIT).is_err());
    assert!(predictor::decode(&data, &params(16, 1, 8, 1), NO_LIMIT).is_err());
    // Colors, BitsPerComponent and Columns default to 1, 8 and 1: a TIFF row of one byte is that byte.
    assert_eq!(predictor::decode(&data, &params(2, 0, 0, 0), NO_LIMIT).unwrap(), data);
}

#[test]
fn predictor_output_limit() {
    let got = predictor::decode(&hex(PNG_ENCODED), &params(15, 3, 8, 4), 20).unwrap();
    same(&got, &hex(PNG_PLAIN)[..20], "limit 20");
}

// ---------------------------------------------------------------------------------------------------------------
// Chained filters

#[test]
fn chain_ascii85_then_flate() {
    let want = lcg(2000, b"abcdefghijklmnop", 12345);
    let text = hex(FLATE_DYNAMIC);
    let a85 = a85_encode(&text);
    let got = decode_chain(&a85, &[Filter::Ascii85, Filter::Flate(None)], NO_LIMIT).unwrap();
    same(&got, &want, "A85 then Fl");
}

#[test]
fn chain_asciihex_then_flate_with_png_predictor() {
    let hex_text: String = PNG_ENCODED_ZLIB.to_uppercase() + ">";
    let filters = [Filter::AsciiHex, Filter::Flate(Some(params(15, 3, 8, 4)))];
    let got = decode_chain(hex_text.as_bytes(), &filters, NO_LIMIT).unwrap();
    same(&got, &hex(PNG_PLAIN), "AHx then Fl+PNG");
}

#[test]
fn chain_names_and_pass_through() {
    assert_eq!(Filter::from_name("Fl", None, None), Filter::Flate(None));
    assert_eq!(Filter::from_name("LZWDecode", None, None), Filter::Lzw { early_change: 1, predictor: None });
    assert_eq!(Filter::from_name("LZW", None, Some(0)), Filter::Lzw { early_change: 0, predictor: None });
    assert_eq!(Filter::from_name("A85", None, None), Filter::Ascii85);
    assert_eq!(Filter::from_name("ASCIIHexDecode", None, None), Filter::AsciiHex);
    assert_eq!(Filter::from_name("RL", None, None), Filter::RunLength);
    assert_eq!(Filter::from_name("DCTDecode", None, None), Filter::PassThrough);
    let data = [9u8, 8, 7];
    assert_eq!(decode_chain(&data, &[Filter::PassThrough], NO_LIMIT).unwrap(), data);
}

#[test]
fn chain_stage_that_cannot_start_gives_an_empty_stream() {
    // A bad flate header and an unknown predictor number both end up as an empty stream, as in pdf.js's makeFilter.
    assert!(decode_chain(&[0, 0, 1], &[Filter::Flate(None)], NO_LIMIT).unwrap().is_empty());
    let bad_predictor = Filter::Flate(Some(params(7, 1, 8, 1)));
    assert!(decode_chain(&hex(FLATE_HELLO), &[bad_predictor], NO_LIMIT).unwrap().is_empty());
}

/// Encodes in ASCII85 (the test needs a second encoder only for the chain: Python's output of the same bytes).
fn a85_encode(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for group in data.chunks(4) {
        let mut word: u32 = 0;
        for (i, &b) in group.iter().enumerate() {
            word |= u32::from(b) << (24 - 8 * i);
        }
        if group.len() == 4 && word == 0 {
            out.push(b'z');
            continue;
        }
        let mut digits = [0u8; 5];
        let mut v = u64::from(word);
        for d in digits.iter_mut().rev() {
            *d = (v % 85) as u8 + b'!';
            v /= 85;
        }
        out.extend_from_slice(&digits[..group.len() + 1]);
    }
    out.extend_from_slice(b"~>");
    out
}

// ---------------------------------------------------------------------------------------------------------------
// RC4

#[test]
fn rc4_known_vectors_and_chunked_state() {
    let mut cipher = rc4::Rc4::new(b"Key");
    assert_eq!(cipher.apply(b"Plaintext"), hex("bbf316e8d940af0ad3"));
    let mut cipher = rc4::Rc4::new(b"Wiki");
    assert_eq!(cipher.apply(b"pedia"), hex("1021bf0420"));
    let whole = rc4::Rc4::new(b"secret").apply(b"the quick brown fox");
    let mut chunked = rc4::Rc4::new(b"secret");
    let mut got = chunked.apply(b"the quick");
    got.extend(chunked.apply(b" brown fox"));
    assert_eq!(got, whole);
    // The data decrypts with the same operation.
    assert_eq!(rc4::Rc4::new(b"secret").apply(&whole), b"the quick brown fox");
}

// ---------------------------------------------------------------------------------------------------------------
// Security handler

const TITLE: &[u8] = b"Secret title of the document";
const CONTENT: &[u8] = b"BT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET";
const FILE_ID: &str = "3836613366316230306263623836366566333435383262316463613466356339";

struct Case {
    name: &'static str,
    v: i64,
    r: i64,
    length: Option<i64>,
    p: i64,
    o: &'static str,
    u: &'static str,
    oe: &'static str,
    ue: &'static str,
    perms: &'static str,
    cfm: Option<CryptFilterMethod>,
    title_enc: &'static str,
    stream_enc: &'static str,
}

impl Case {
    fn dict(&self) -> EncryptDict {
        let std_cf = self.cfm.clone().map(|cfm| CryptFilter { cfm: Some(cfm), length: None, auth_event: None });
        EncryptDict {
            filter: Some("Standard".into()),
            v: Some(self.v),
            r: Some(self.r),
            length: self.length,
            o: hex(self.o),
            u: hex(self.u),
            oe: hex(self.oe),
            ue: hex(self.ue),
            perms: hex(self.perms),
            p: self.p,
            encrypt_metadata: None,
            cf: std_cf.clone().map(|f| vec![("StdCF".to_string(), f)]),
            stm_f: std_cf.clone().map(|_| "StdCF".to_string()),
            str_f: std_cf.map(|_| "StdCF".to_string()),
            eff: None,
        }
    }

    fn open(&self, password: Option<&str>) -> Result<CipherTransformFactory, SecurityError> {
        CipherTransformFactory::new(&self.dict(), &hex(FILE_ID), password)
    }

    fn check_decrypts(&self, factory: &CipherTransformFactory) {
        let title = factory.create_cipher_transform(1, 0).decrypt_string(&hex(self.title_enc)).unwrap();
        assert_eq!(title, TITLE, "{}: string", self.name);
        let stream = factory
            .create_cipher_transform(5, 0)
            .decrypt_stream(&hex(self.stream_enc), None, false, NO_LIMIT)
            .unwrap();
        assert_eq!(stream, CONTENT, "{}: stream", self.name);
    }
}

fn password_code(result: Result<CipherTransformFactory, SecurityError>) -> u8 {
    match result {
        Err(SecurityError::Password { code, .. }) => code,
        Err(other) => panic!("not a password error: {other}"),
        Ok(_) => panic!("the document opened"),
    }
}

fn open_cases() -> Vec<Case> {
    vec![
    Case {
        name: "rc4_40",
        v: 1,
        r: 2,
        length: Some(40),
        p: 4294967292,
        o: "c92422687facee686e373f10b5c7d04738053152f7e2ee30e11c69ec442576ab",
        u: "a3e39a9a41cec3850080415ca9c679c4233bd1a245822bd4c24eb870b98021c0",
        oe: "",
        ue: "",
        perms: "",
        cfm: None,
        title_enc: "6977439c49d0461d41313e68898a2ade9609cdfc739a099eb8c05d4e",
        stream_enc: "d0eb39424214e4eb116c2b311f476040e0533c78ee4cf532984d76bc75f7160f69a2144c2b10b648",
    },
    Case {
        name: "rc4_128",
        v: 2,
        r: 3,
        length: Some(128),
        p: 4294967292,
        o: "566fa873ee33c797cd3b904fdadf814afa34df9a38f6ed41b984e2c6da2aa6f5",
        u: "a932071fc3351f83a0fc9289b9dda7be28bf4e5e4e758a4164004e56fffa0108",
        oe: "",
        ue: "",
        perms: "",
        cfm: None,
        title_enc: "4c068b7e790ed965e8a647a6d8279fd19b17c6d1c66e2599c2813858",
        stream_enc: "854660dc6caa36cdfd9ef17331c96cda4b21e9addbdb599a8394eddce5341b0bffc88f856c0d3876",
    },
    Case {
        name: "aes_128",
        v: 4,
        r: 4,
        length: Some(128),
        p: 4294967292,
        o: "566fa873ee33c797cd3b904fdadf814afa34df9a38f6ed41b984e2c6da2aa6f5",
        u: "a932071fc3351f83a0fc9289b9dda7be28bf4e5e4e758a4164004e56fffa0108",
        oe: "",
        ue: "",
        perms: "",
        cfm: Some(CryptFilterMethod::AesV2),
        title_enc: "be0a94454b149531623affbeddbad188352f7dc642adab048b1ed7507fa044e33d2e83df263ceb108690bf46048e65a4",
        stream_enc: "3806b2922b577f0d137e42f6d22fc5a68850a264d12e1dcf86a26f2943b9acdfc94c8e45896bd707127d08aa817896a6bf8c1b212d631de256b1e31ef00d896d",
    },
    Case {
        name: "aes_256_r5",
        v: 5,
        r: 5,
        length: Some(256),
        p: 4294967292,
        o: "5b3877e1f13e1520a0a02dd6ba73ccad64db2b9b0a0ab178d0c946df0f500f654325e863ad83bbf71f97ee7a2422a3ce",
        u: "96040438a8052d93dba76921be78e63f7fa94cb39060bc15f8c4a3d9a81839fb970b30497df58c071e195558663da104",
        oe: "72f536e993d5967c1dc5d98d2e2ab2c97f275f552fe2beb2fe53febc30d5dc3b",
        ue: "c5dfabfb3576486e3d71fad7a7d5163c06a2918f42514978e409b63db3d91cd3",
        perms: "333ee9cdb1845cdf2100e49ffc05526f",
        cfm: Some(CryptFilterMethod::AesV3),
        title_enc: "f104cc0ade50a9fea1a9a55b7b0174c0cee42a4906c121e54d493362c9def58cb42e6e774a0fe428d73875fad2733bc0",
        stream_enc: "05f040b76e9ab56edad473b29dd93022baff75b8241536d598ccc5ef0335ebe057ca48629842a2314159fad3f99255ac7a68281d8067ee118305f46bb7729491",
    },
    Case {
        name: "aes_256_r6",
        v: 5,
        r: 6,
        length: Some(256),
        p: 4294967292,
        o: "223cc4abe4b0bf4b85ea85fe94ca01304876d013ce9bdc9b5355252d59b557044374e1272058848d93ab4cf6086d4534",
        u: "153f23b468d8bd824acfb71df423aaf048ae7e6a74eeee05e61de2505824075a1b982b13b6a065670eed48e5ecc52841",
        oe: "d5f31aba5579e1b7095181b01d7ba560118fdf2c7c47f1f8e77c79ebaf1bfe1e",
        ue: "6d0c789c17e757c18a246a85e046c1dedc115188622483b1e50fc3db7ded9c9d",
        perms: "704f2c105704689b74a4daa86548f159",
        cfm: Some(CryptFilterMethod::AesV3),
        title_enc: "5dd1627cd20028713f220eda32994f9ef2b02efa711c0f7615e54d2acd62729d7bd2786e7622ce54fb192665d0861a20",
        stream_enc: "ff7474d616dfdc8d9185cdcf676e6af38b9046d67605fb689dba551c50be06e54b65c4fd7ee5c8cc3b95fdb8e0d335f792ca4f7264c0642e252fe3c9ec45ef77",
    },
    ]
}

fn user_cases() -> Vec<Case> {
    vec![
    Case {
        name: "rc4_40_user",
        v: 1,
        r: 2,
        length: Some(40),
        p: 4294967292,
        o: "94e8094419662a774442fb072e3d9f19e9d130ec09a4d0061e78fe920f7ab62f",
        u: "34ff6b7a810020b6b02bb8ba42f60777574a93bfaf496cec57f5dd55c7fe7f56",
        oe: "",
        ue: "",
        perms: "",
        cfm: None,
        title_enc: "b19578b4cacbd5c08c1b44074b67ce2c11dc12236b9a67869f0c7864",
        stream_enc: "4b8625011281ae65fe57888bb6131ff13d83df285ac368abb43914947e5e24c86531139a2961c561",
    },
    Case {
        name: "rc4_128_user",
        v: 2,
        r: 3,
        length: Some(128),
        p: 4294967292,
        o: "0ba3835f88f90388e74e54584125ce142be0de24c6b0d37746e075b891756671",
        u: "3a71d3cd15947682228427ff6e267ce128bf4e5e4e758a4164004e56fffa0108",
        oe: "",
        ue: "",
        perms: "",
        cfm: None,
        title_enc: "b2f67b1b01f3e80178f45c0e7574444958fef9e4c540f71f88f89d76",
        stream_enc: "2551fa57d3db562bbb05729689157efff70072a88677ea1188881c65091221c4b1334ff0cd6079f0",
    },
    Case {
        name: "aes_128_user",
        v: 4,
        r: 4,
        length: Some(128),
        p: 4294967292,
        o: "0ba3835f88f90388e74e54584125ce142be0de24c6b0d37746e075b891756671",
        u: "3a71d3cd15947682228427ff6e267ce128bf4e5e4e758a4164004e56fffa0108",
        oe: "",
        ue: "",
        perms: "",
        cfm: Some(CryptFilterMethod::AesV2),
        title_enc: "95d47441276d813960df84f20291afb542fe279625102154c78d6c1d89dae1b0c8a001e4f18131adadbc3ea959340d50",
        stream_enc: "047c47b58392c32a55231b4b6a5f49eea06d152ac6c3cc50c1ceabaa48043d19e9cbdc1bde7cfcdbc0527861263265fc367ba941269851845815a82e737babd9",
    },
    Case {
        name: "aes_256_r5_user",
        v: 5,
        r: 5,
        length: Some(256),
        p: 4294967292,
        o: "44beda6ec9bc1c7b536bc4c373c902fca4be167ce603a96ac34aca6ce82644eb01d3d28bc68cfd297b24e70b76371893",
        u: "738f7963fe660d18fd47723958b0e62260a9ba2598c5bcc965aa2d67a5b2b0e748088e2620352ec74abc2b9c7066b642",
        oe: "f584b4b6066912acc2379afb0a5c1d7fff3e0de5dc816d90d82596f304f850e1",
        ue: "8d582a6f20272b221920968b45f44ecff918008574eb4f3cf224e5ec93155321",
        perms: "bafb7840b31b8d9ca184bbdcd2ecc857",
        cfm: Some(CryptFilterMethod::AesV3),
        title_enc: "010f70523bc61f7085695f7985c0879e65c5ada095f0e73598b3c8e58fda640133f5b6520f6f8ab9b4e2e661f51bfd78",
        stream_enc: "4e50ef3b1040a6037e85a4a931646660239332f53f923c49596125ade8a904703efd62a1f289dfdeb4319f50b5e44da3a3bf1e96a7527dda110bd7f7c487f2bc",
    },
    Case {
        name: "aes_256_r6_user",
        v: 5,
        r: 6,
        length: Some(256),
        p: 4294967292,
        o: "779d9d361d61a5ddb2610ac6a525ef9859fc3645cd7a069d9453f1701fafa3069383ec98f668fe52ceaec2e9a8f313ed",
        u: "2a1977d3f32da8f3c9a1e3c585c6a25c5ee8e34559c36b14ebaf3ed361ed3fecfde57350d2deb7869a4679e1c824afe7",
        oe: "3bfb21df12684b79af9702b7825bc2f7f7181c071f769a4413a95e577b033b8c",
        ue: "1ed9ee01564fb667432ede434b2763ade3b759a4095ff4abc9b2e8e899147315",
        perms: "84be67a29b038e834e53f09fb4062a23",
        cfm: Some(CryptFilterMethod::AesV3),
        title_enc: "030bb5182b12910351c2205bc993a8399b8d2fe2995306adea8e43e0a9a1bdce6dab5dd23bc976187f64a43bad10bccf",
        stream_enc: "a51e6e491c773b5156bf972684784be665ef011095eb8ed5ca86e2c478081931be19bc83caf8739eb0ffb044d18a58b75a5b1b975799b5bc8bfe301a2bd4b4a6",
    },
    ]
}


#[test]
fn empty_user_password_opens_every_revision() {
    for case in open_cases() {
        for password in [None, Some("")] {
            let factory = case.open(password).unwrap();
            case.check_decrypts(&factory);
        }
    }
}

#[test]
fn owner_password_opens_a_document_with_an_empty_user_password() {
    for case in open_cases() {
        let factory = case.open(Some("owner")).unwrap();
        case.check_decrypts(&factory);
    }
}

#[test]
fn user_password_is_needed_and_checked() {
    for case in user_cases() {
        assert_eq!(password_code(case.open(None)), NEED_PASSWORD, "{}: none", case.name);
        assert_eq!(password_code(case.open(Some(""))), NEED_PASSWORD, "{}: empty", case.name);
        assert_eq!(password_code(case.open(Some("wrong"))), INCORRECT_PASSWORD, "{}: wrong", case.name);
        let factory = case.open(Some("user")).unwrap();
        case.check_decrypts(&factory);
    }
}

#[test]
fn owner_password_opens_a_document_with_a_user_password() {
    for case in user_cases() {
        let factory = case.open(Some("owner")).unwrap();
        case.check_decrypts(&factory);
    }
}

#[test]
fn password_error_codes_and_messages() {
    let case = &user_cases()[0];
    match case.open(None) {
        Err(error @ SecurityError::Password { .. }) => {
            assert_eq!(error.to_string(), "No password given");
            assert_eq!(error, SecurityError::Password { code: 1, message: "No password given" });
        }
        _ => panic!("expected a password error"),
    }
    match case.open(Some("x")) {
        Err(error) => assert_eq!(error, SecurityError::Password { code: 2, message: "Incorrect Password" }),
        Ok(_) => panic!("the document opened"),
    }
}

#[test]
fn set_password_reopens_the_document() {
    let case = &user_cases()[2];
    let mut factory = case.open(Some("user")).unwrap();
    assert_eq!(factory.set_password(Some("nope")), Err(SecurityError::Password { code: 2, message: "Incorrect Password" }));
    factory.set_password(Some("owner")).unwrap();
    case.check_decrypts(&factory);
}

#[test]
fn encrypt_dictionary_errors() {
    let case = &open_cases()[0];
    let mut dict = case.dict();
    dict.filter = Some("Adobe.PubSec".into());
    assert_eq!(
        CipherTransformFactory::new(&dict, &hex(FILE_ID), None).unwrap_err(),
        SecurityError::Format("unknown encryption method".into())
    );
    let mut dict = case.dict();
    dict.v = Some(3);
    assert_eq!(
        CipherTransformFactory::new(&dict, &hex(FILE_ID), None).unwrap_err(),
        SecurityError::Format("unsupported encryption algorithm".into())
    );
    let mut dict = case.dict();
    dict.length = Some(44);
    assert_eq!(
        CipherTransformFactory::new(&dict, &hex(FILE_ID), None).unwrap_err(),
        SecurityError::Format("invalid key length".into())
    );
}

#[test]
fn missing_length_defaults_to_40_bits_below_revision_4() {
    let case = &open_cases()[0];
    let mut dict = case.dict();
    dict.length = None;
    let factory = CipherTransformFactory::new(&dict, &hex(FILE_ID), None).unwrap();
    case.check_decrypts(&factory);
}

#[test]
fn aes_tolerates_damaged_padding() {
    let case = &open_cases()[2];
    let factory = case.open(None).unwrap();
    let transform = factory.create_cipher_transform(1, 0);
    let good = hex(case.title_enc);
    assert_eq!(transform.decrypt_string(&good).unwrap(), TITLE);
    // The padding of the last block no longer agrees with its count: nothing is removed.
    for delta in [0x01, 0x80] {
        let mut damaged = good.clone();
        damaged[16 + 15] ^= delta;
        let got = transform.decrypt_string(&damaged).unwrap();
        assert_eq!(got.len(), 32, "delta {delta}");
        assert_eq!(&got[28..31], &[4, 4, 4], "delta {delta}");
        assert_eq!(got[31], 4 ^ delta, "delta {delta}");
    }
    // A trailing partial block is dropped, and fewer than 16 bytes give nothing.
    let mut long = good.clone();
    long.extend_from_slice(&[1, 2, 3]);
    assert_eq!(transform.decrypt_string(&long).unwrap(), TITLE);
    assert!(transform.decrypt_string(&good[..10]).unwrap().is_empty());
    assert!(transform.decrypt_string(&[]).unwrap().is_empty());
}

#[test]
fn stream_decryption_in_chunks_matches_whole_decryption() {
    // 2000 bytes of text, encrypted with RC4 by the same key the document uses (the cipher is its own inverse).
    let case = &open_cases()[1];
    let factory = case.open(None).unwrap();
    let transform = factory.create_cipher_transform(5, 0);
    let plain = lcg(2000, b"abcdefgh", 4);
    let encrypted = transform.decrypt_stream(&plain, None, false, NO_LIMIT).unwrap();
    assert_ne!(encrypted, plain);
    assert_eq!(transform.decrypt_stream(&encrypted, None, false, NO_LIMIT).unwrap(), plain);
    assert_eq!(transform.decrypt_stream(&encrypted, None, false, 700).unwrap(), plain[..700]);
}

#[test]
fn identity_crypt_filters_and_efopen() {
    let case = &user_cases()[2];
    // Streams and strings in the clear, only embedded files encrypted and opened by a password the viewer asks for.
    let mut dict = case.dict();
    dict.stm_f = None;
    dict.str_f = None;
    dict.eff = Some("StdCF".into());
    dict.cf = Some(vec![(
        "StdCF".to_string(),
        CryptFilter { cfm: Some(CryptFilterMethod::AesV2), length: None, auth_event: Some("EFOpen".into()) },
    )]);
    let factory = CipherTransformFactory::new(&dict, &hex(FILE_ID), None).unwrap();
    let transform = factory.create_cipher_transform(5, 0);
    let clear = [1u8, 2, 3];
    assert_eq!(transform.decrypt_string(&clear).unwrap(), clear);
    assert_eq!(transform.decrypt_stream(&clear, None, false, NO_LIMIT).unwrap(), clear);
    // An embedded file needs the key the document was opened without.
    let error = transform.decrypt_stream(&clear, None, true, NO_LIMIT).unwrap_err();
    assert_eq!(error, SecurityError::Password { code: 1, message: "No password given" });
    // Without the EFOpen event the same document needs its password.
    dict.cf = Some(vec![("StdCF".to_string(), CryptFilter { cfm: Some(CryptFilterMethod::AesV2), ..Default::default() })]);
    assert_eq!(password_code(CipherTransformFactory::new(&dict, &hex(FILE_ID), None)), NEED_PASSWORD);
}

#[test]
fn unknown_crypt_filter_method_is_a_format_error() {
    let case = &open_cases()[2];
    let mut dict = case.dict();
    dict.cf = Some(vec![(
        "StdCF".to_string(),
        CryptFilter { cfm: Some(CryptFilterMethod::Other("Foo".into())), ..Default::default() },
    )]);
    // The key derivation does not read the method: the document opens, using the filter fails.
    let factory = CipherTransformFactory::new(&dict, &hex(FILE_ID), None).unwrap();
    let error = factory.create_cipher_transform(1, 0).decrypt_string(&[0; 32]).unwrap_err();
    assert_eq!(error, SecurityError::Format("Unknown crypto method".into()));
    // A filter the dictionary names with the method None leaves the data alone.
    dict.cf = Some(vec![("StdCF".to_string(), CryptFilter { cfm: Some(CryptFilterMethod::None), ..Default::default() })]);
    let factory = CipherTransformFactory::new(&dict, &hex(FILE_ID), None).unwrap();
    assert_eq!(factory.create_cipher_transform(1, 0).decrypt_string(b"plain").unwrap(), b"plain");
}
