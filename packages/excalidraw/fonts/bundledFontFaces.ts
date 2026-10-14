import { CascadiaFontFaces } from "./Cascadia";
import { ComicShannsFontFaces } from "./ComicShanns";
import { ExcalifontFontFaces } from "./Excalifont";
import { LiberationFontFaces } from "./Liberation";
import { LilitaFontFaces } from "./Lilita";
import { NunitoFontFaces } from "./Nunito";
import { VirgilFontFaces } from "./Virgil";
import { XiaolaiFontFaces } from "./Xiaolai";

/** Reuse the editor's font faces and their subset order, never a substitute font. */
export const bundledFontFaces = {
  Virgil: VirgilFontFaces,
  Cascadia: CascadiaFontFaces,
  Excalifont: ExcalifontFontFaces,
  Nunito: NunitoFontFaces,
  "Lilita One": LilitaFontFaces,
  "Comic Shanns": ComicShannsFontFaces,
  "Liberation Sans": LiberationFontFaces,
  Xiaolai: XiaolaiFontFaces,
};
