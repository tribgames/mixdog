// Parity fixture: declaration and import shapes the graph reports for Obj-C.
#import <Foundation/Foundation.h>
#import "Store.h"
@import UIKit;

@protocol Storage <NSObject>
- (NSString *)read:(NSString *)key;
@end

@interface Store : NSObject <Storage>
@property(nonatomic, copy) NSString *name;
- (instancetype)initWithName:(NSString *)name;
- (NSString *)read:(NSString *)key;
@end

@implementation Store

- (instancetype)initWithName:(NSString *)name {
  self = [super init];
  if (self) {
    _name = [name copy];
  }
  return self;
}

- (NSString *)read:(NSString *)key {
  return [NSString stringWithFormat:@"%@:%@", self.name, key];
}

@end

static NSString *StoreDescription(Store *store) {
  return [store read:@"desc"];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    Store *store = [[Store alloc] initWithName:@"main"];
    NSLog(@"%@", StoreDescription(store));
  }
  return argc > 1 ? 1 : 0;
}
