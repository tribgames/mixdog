"""Extract pinned ICU resources without loading a native ICU or running Node.

Resource format: ICU 77.1 common/uresdata.h, uresdata.cpp, uresbund.cpp.
The generator reads only the official Node data archive and writes owned data.
Unicode/ICU license is retained with that archive.
"""
import bz2
import hashlib
import json
import pathlib
import struct
import datetime
import gzip
import re

ROOT = pathlib.Path(__file__).resolve().parents[3]
REFERENCE = ROOT / "native/core/fixtures/js-date-string/reference"
ARCHIVE = REFERENCE / "icudt77l.dat.bz2"
PINNED = "488a0a666ba33dace736d0788a8973729c8d83f3f4966d0fed1be7ad162d4729"

def u16(b, at): return struct.unpack_from("<H", b, at)[0]
def u32(b, at): return struct.unpack_from("<I", b, at)[0]
def i32(b, at): return struct.unpack_from("<i", b, at)[0]

class Package:
    def __init__(self):
        data = ARCHIVE.read_bytes()
        assert hashlib.sha256(data).hexdigest() == PINNED
        data = bz2.decompress(data)
        assert data[12:16] == b"CmnD" and data[8] == 0
        h = u16(data, 0)
        entries = []
        for i in range(u32(data, h)):
            name, offset = struct.unpack_from("<II", data, h + 4 + i * 8)
            name = data[h+name:data.index(0, h+name)].decode("ascii")
            entries.append((name.removeprefix("icudt77l/"), h + offset))
        self.files = {name: data[start:entries[i+1][1] if i+1<len(entries) else len(data)] for i,(name,start) in enumerate(entries)}
        self.bundles = {}

    def bundle(self, name):
        if name not in self.bundles:
            self.bundles[name] = Bundle(self, name, self.files[name + ".res"])
        return self.bundles[name]

class Bundle:
    def __init__(self, package, name, data):
        assert data[12:16] == b"ResB" and data[8] == 0 and data[16] in (2,3)
        self.package, self.name = package, name
        self.b = data[u16(data,0):]
        self.root = u32(self.b,0)
        count = u32(self.b,4) & 255
        self.ix = [u32(self.b,4+4*i) for i in range(count)]
        self.local_keys = 4*self.ix[1] if self.ix[1] > 1+count else 0
        self.units = 4*self.ix[1]
        self.pool_limit = ((self.ix[0] >> 8) if data[16]>=3 else 0) | ((self.ix[5]&0xf000)<<12)
        self.pool16_limit = self.ix[5] >> 16
        self.pool = None
        if self.ix[5] & 4:
            parent = name.rsplit('/',1)[0]+'/' if '/' in name else ''
            self.pool = package.bundle(parent+'pool')
            assert self.ix[7] == self.pool.ix[7]

    def key(self, offset, wide=False):
        if wide:
            pooled = offset & 0x80000000
            offset &= 0x7fffffff
        else:
            pooled = offset >= self.local_keys
            if pooled: offset -= self.local_keys
        if pooled:
            assert self.pool is not None
            b = self.pool.b
            offset += (1+(self.pool.ix[0]&255))*4
        else: b = self.b
        return b[offset:b.index(0,offset)].decode('ascii')

    def string16(self, offset, resource16=False):
        if resource16 and offset >= self.pool16_limit:
            offset += self.pool_limit-self.pool16_limit
        if offset < self.pool_limit:
            assert self.pool is not None
            b, pos = self.pool.b, self.pool.units + 2*offset
        else: b, pos = self.b, self.units+2*(offset-self.pool_limit)
        first = u16(b,pos)
        if not 0xdc00 <= first <= 0xdfff:
            end = pos
            while u16(b,end): end += 2
            return b[pos:end].decode('utf-16-le')
        if first < 0xdfef: length, pos = first&0x3ff,pos+2
        elif first < 0xdfff: length,pos = ((first-0xdfef)<<16)|u16(b,pos+2),pos+4
        else: length,pos = (u16(b,pos+2)<<16)|u16(b,pos+4),pos+6
        return b[pos:pos+2*length].decode('utf-16-le')

    def table(self, res):
        typ, off = res>>28,res&0xfffffff
        if off == 0: return {}
        if typ == 2:
            pos = off*4; n=u16(self.b,pos); keys=[u16(self.b,pos+2+2*i) for i in range(n)]
            start=pos+2*(1+n+((~n)&1))
            return {self.key(k):u32(self.b,start+4*i) for i,k in enumerate(keys)}
        if typ == 4:
            pos=off*4;n=u32(self.b,pos)
            return {self.key(u32(self.b,pos+4+4*i),True):u32(self.b,pos+4+4*n+4*i) for i in range(n)}
        if typ == 5:
            pos=self.units+2*off;n=u16(self.b,pos);out={}
            for i in range(n):
                v=u16(self.b,pos+2+2*n+2*i)
                if v>=self.pool16_limit:v+=self.pool_limit-self.pool16_limit
                out[self.key(u16(self.b,pos+2+2*i))]=0x60000000|v
            return out
        raise ValueError((self.name, 'not a table',hex(res)))

    def at(self, *keys):
        res=self.root
        for key in keys:
            res=self.table(res).get(key)
            if res is None:return None
        return self.read(res)

    def read(self,res):
        typ,off=res>>28,res&0xfffffff
        if typ in (2,4,5):return {key:self.read(value) for key,value in self.table(res).items()}
        if typ==6:return self.string16(off)
        if typ in (0,3):
            s='' if off==0 else self.b[off*4+4:off*4+4+2*u32(self.b,off*4)].decode('utf-16-le')
            return {'$alias':s} if typ==3 else s
        if typ==7:return off-(1<<28) if off&(1<<27) else off
        if typ==8:
            if off==0:return []
            n=u32(self.b,off*4);return [self.read(u32(self.b,off*4+4+4*i)) for i in range(n)]
        if typ==9:
            pos=self.units+2*off;n=u16(self.b,pos);return [self.string16(u16(self.b,pos+2+2*i),True) for i in range(n)]
        if typ==14:
            if off==0:return []
            n=u32(self.b,off*4);return [i32(self.b,off*4+4+4*i) for i in range(n)]
        if typ==1:
            n=u32(self.b,off*4) if off else 0;return {'$binary':self.b[off*4+4:off*4+4+n].hex()}
        raise ValueError((self.name,hex(res),'unsupported resource type'))

def generate():
    p=Package()
    locales={}
    numbers={}
    for file in p.files:
        if file.startswith('zone/') and file.endswith('.res') and file not in ('zone/pool.res','zone/res_index.res','zone/tzdbNames.res'):
            name=file[5:-4];b=p.bundle(file[:-4]);tree=b.read(b.root)
            out={}
            for source,target in [('%%ALIAS','a'),('%%Parent','p')]:
                if source in tree:out[target]=tree[source]
            zone=tree.get('zoneStrings',{})
            out['n']={k:[v.get('ls'),v.get('ld')] for k,v in zone.items() if isinstance(v,dict) and ('ls' in v or 'ld' in v)}
            for key in ('gmtFormat','gmtZeroFormat','hourFormat'):
                if key in zone:out[key]=zone[key]
            locales[name]=out
        elif '/' not in file and file.endswith('.res') and file not in ('pool.res','res_index.res'):
            name=file[:-4]
            # Locale resource filenames; other root-level data files are handled below.
            if not (name=='root' or (2<=len(name.split('_')[0])<=3 and name.replace('_','').isalnum())):continue
            b=p.bundle(name);out={}
            for source,target in [('%%ALIAS','a'),('%%Parent','p')]:
                value=b.at(source)
                if value is not None:out[target]=value
            for key in ('default','native','traditional','finance'):
                value=b.at('NumberElements',key)
                if value is not None:out[key]=value
            numbers[name]=out
    z=p.bundle('zoneinfo64');zone=z.read(z.root)
    assert zone['TZVersion']=='2025b'
    zones=[]
    for item in zone['Zones']:
        if isinstance(item,int):zones.append(item);continue
        times=[]
        for key in ['transPre32','trans','transPost32']:
            values=item.get(key,[])
            if key=='trans':times.extend(values)
            else:
                for i in range(0,len(values),2):times.append((values[i]<<32)|(values[i+1]&0xffffffff))
        mapping=bytes.fromhex(item.get('typeMap',{'$binary':''})['$binary'])
        assert len(times)==len(mapping)
        offsets=item['typeOffsets']
        trans=[[t,offsets[2*typ],offsets[2*typ+1]] for t,typ in zip(times,mapping)]
        out={'i':offsets[:2],'t':trans}
        if 'finalRule' in item:out['f']=[item['finalYear'],item['finalRaw'],zone['Rules'][item['finalRule']]]
        zones.append(out)
    tz=p.bundle('timezoneTypes');canonical=tz.at('typeMap','timezone');aliases=tz.at('typeAlias','timezone')
    mapping={}
    for i,name in enumerate(zone['Names']):
        key=name.replace('/',':')
        if key in canonical:canonical_name=name
        elif key in aliases:canonical_name=aliases[key]
        else:
            j=i
            while isinstance(zones[j],int):j=zones[j]
            deref=zone['Names'][j];canonical_name=aliases.get(deref.replace('/',':'),deref)
        mapping[name]=[i,canonical_name.replace('/',':')]
    meta=p.bundle('metaZones').at('metazoneInfo')
    timestamp=lambda s:int(datetime.datetime.strptime(s,'%Y-%m-%d %H:%M').replace(tzinfo=datetime.timezone.utc).timestamp())
    metazones={k:[[r[0],timestamp(r[1] if len(r)==3 else '1970-01-01 00:00'),timestamp(r[2] if len(r)==3 else '9999-12-31 23:59')] for r in rows] for k,rows in meta.items()}
    systems=p.bundle('numberingSystems').at('numberingSystems')
    digits={k:v['desc'] for k,v in systems.items() if not v['algorithmic'] and v['radix']==10 and len(v['desc'])==10}
    locale_aliases=p.bundle('metadata').at('alias','language')
    locale_aliases={k:v['replacement'] for k,v in locale_aliases.items()}
    result={'icu':'77.1','cldr':'47.0','tz':'2025b','locales':locales,'numbers':numbers,'digits':digits,'numberingSystems':list(systems),'localeAliases':locale_aliases,'zoneNames':mapping,'zones':zones,'meta':metazones}
    raw=json.dumps(result,ensure_ascii=False,separators=(',',':')).encode()
    dest=ROOT/'native/core/crates/mixdog-js/src/date_string/data';dest.mkdir(parents=True,exist_ok=True)
    compressed=gzip.compress(raw,mtime=0)
    (dest/'icu77-date-names.json.gz').write_bytes(compressed)
    manifest={'archiveUrl':'https://raw.githubusercontent.com/nodejs/node/v22.20.0/deps/icu-small/source/data/in/icudt77l.dat.bz2','archiveSha256':PINNED,'icu':'77.1','cldr':'47.0','tz':'2025b','zoneLocales':len(locales),'numberLocales':len(numbers),'zones':len(zones),'uncompressedBytes':len(raw),'compressedBytes':len(compressed),'dataSha256':hashlib.sha256(compressed).hexdigest()}
    # ICU's locale-ID and BCP47 conversion tables, not sys-locale UI preferences.
    uloc=re.sub(r'/\*[\s\S]*?\*/|//[^\n]*','',(REFERENCE/'uloc.cpp').read_text(encoding='utf8'))
    ultag=re.sub(r'/\*[\s\S]*?\*/|//[^\n]*','',(REFERENCE/'uloc_tag.cpp').read_text(encoding='utf8'))
    def array(source,name):
        body=re.search(r'\b'+name+r'\[.*?=\s*\{([\s\S]*?)\};',source).group(1)
        return [match.group(1) if match.group(1) is not None else None for match in re.finditer(r'"([^"]*)"|(nullptr)',body)]
    languages,languages3=array(uloc,'LANGUAGES'),array(uloc,'LANGUAGES_3')
    countries,countries3=array(uloc,'COUNTRIES'),array(uloc,'COUNTRIES_3')
    assert len(languages)==len(languages3) and len(countries)==len(countries3)
    deprecated_languages=array(ultag,'DEPRECATEDLANGS');deprecated_regions=array(ultag,'DEPRECATEDREGIONS')
    canonical=array(uloc,'CANONICALIZE_MAP')
    normalization={'language3':{a:b for a,b in zip(languages3,languages) if a},'region3':{a:b for a,b in zip(countries3,countries) if a},'languageTags':dict(zip(deprecated_languages[::2],deprecated_languages[1::2])),'regionTags':dict(zip(deprecated_regions[::2],deprecated_regions[1::2])),'canonical':dict(zip(canonical[::2],canonical[1::2]))}
    legacy=array(ultag,'LEGACY');normalization['legacy']=dict(zip(legacy[::2],legacy[1::2]))
    key_bundle=p.bundle('keyTypeData');key_data=key_bundle.read(key_bundle.root)
    normalization['keys']={k:(v or k) for k,v in key_data['keyMap'].items()}
    forward={};reverse={}
    for key,types in key_data['typeMap'].items():
        if '$alias' in types:
            assert key=='timezone'
            types=tz.at('typeMap','timezone')
        forward[key]={};reverse[key]={}
        for legacy_type,bcp_type in types.items():
            if legacy_type.isupper() and '_' in legacy_type:continue
            legacy_type=legacy_type.replace(':','/')
            bcp_type=bcp_type or legacy_type
            forward[key][legacy_type.lower()]=bcp_type
            reverse[key][bcp_type.lower()]=legacy_type
        aliases=key_data.get('typeAlias',{}).get(key,{})
        if '$alias' in aliases:aliases=tz.at('typeAlias','timezone')
        for alias,target in aliases.items():
            forward[key][alias.replace(':','/').lower()]=forward[key].get(target.lower(),target)
        for alias,target in key_data.get('bcpTypeAlias',{}).get(key,{}).items():
            reverse[key][alias.lower()]=reverse[key].get(target.lower(),target)
    normalization['types']=forward;normalization['reverseTypes']=reverse
    locale_dest=ROOT/'native/core/crates/mixdog-js/src/default_locale/data';locale_dest.mkdir(parents=True,exist_ok=True)
    locale_bytes=(json.dumps(normalization,separators=(',',':'))+'\n').encode()
    (locale_dest/'icu77-locale.json').write_bytes(locale_bytes)
    manifest['localeDataBytes']=len(locale_bytes)
    manifest['localeDataSha256']=hashlib.sha256(locale_bytes).hexdigest()
    contracts=[]
    for path in sorted(REFERENCE.glob('*.cpp')):
        folder='common' if path.name in ('putil.cpp','uloc.cpp','uloc_tag.cpp') else 'i18n'
        contracts.append({'file':path.name,'url':f'https://raw.githubusercontent.com/nodejs/node/v22.20.0/deps/icu-small/source/{folder}/{path.name}','sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    manifest['sourceContracts']=contracts
    manifest['licenses']={path.name:hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(REFERENCE.glob('LICENSE.*'))}
    (dest/'PROVENANCE.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf8')
    print(json.dumps(manifest))
    return result

if __name__=='__main__':generate()
